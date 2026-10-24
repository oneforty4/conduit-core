import type { BlobStore } from './blob-store.ts';
import { compareKeys, validateKey, validateNamespace, validateValue } from './keys.ts';
import { Mutex } from './mutex.ts';

const MANIFEST_NS = 'save_manifest';
const DATA_NS = 'save_data';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
/** Structural marker lets storage consumers distinguish corruption from retryable I/O failures. */
export class SaveCorruptionError extends Error {
  override readonly name = 'SaveCorruptionError';
  readonly unrecoverable = true;
}
export interface SaveWrite {
  namespace: string;
  key: string;
  bytes: Uint8Array | null;
}
export interface SaveReference {
  namespace: string;
  key: string;
  blobNamespace: string;
  blobKey: string;
  /** Absent only before legacy import. Published references always carry a checked size. */
  byteLength?: number;
}
export interface ApplicationSaveManifest {
  kind: 'app-world';
  version: 1;
  generation: number;
  completedTick: number;
  compatibility: unknown;
  gameSaveVersion: number;
  stateSchemaHash: number;
  entries: SaveReference[];
}
export interface CaptureImage {
  kind: 'app-world';
  version: 1;
  baseGeneration: number;
  completedTick: number;
  compatibility: unknown;
  gameSaveVersion: number;
  stateSchemaHash: number;
  references: SaveReference[];
  writes: SaveWrite[];
  /** Staging revisions are acknowledgements, not authoritative domain state. */
  revisions: { namespace: string; key: string; revision: number }[];
}
interface Dirty {
  namespace: string;
  key: string;
  bytes: Uint8Array | null;
  revision: number;
}
export interface GenerationStoreOptions {
  maxOverlayBytes?: number;
  maxCaptureBytes?: number;
  maxKeys?: number;
  retainGenerations?: number;
}
const identity = (namespace: string, key: string) => JSON.stringify([namespace, key]);
function detachedJson<T>(value: T, maximumBytes = 64 * 1024 * 1024): T {
  let budget = 0;
  let nodes = 0;
  const ancestors = new Set<object>();
  const consume = (size: number) => {
    budget += size;
    if (budget > maximumBytes) throw new Error('GenerationStore: metadata byte limit exceeded');
  };
  const stringSize = (text: string): number => {
    let size = 2;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code < 32) size += 6;
      else if (code === 34 || code === 92) size += 2;
      else if (code < 128) size++;
      else if (code < 2048) size += 2;
      else if (
        code >= 0xd800 &&
        code <= 0xdbff &&
        i + 1 < text.length &&
        text.charCodeAt(i + 1) >= 0xdc00 &&
        text.charCodeAt(i + 1) <= 0xdfff
      ) {
        size += 4;
        i++;
      } else size += code >= 0xd800 && code <= 0xdfff ? 6 : 3;
      if (size > maximumBytes) throw new Error('GenerationStore: metadata byte limit exceeded');
    }
    return size;
  };
  const clone = (input: unknown, depth: number): unknown => {
    if (++nodes > 100_000 || depth > 128)
      throw new Error('GenerationStore: metadata structural limit exceeded');
    if (input === null || typeof input === 'boolean') {
      consume(input === false ? 5 : 4);
      return input;
    }
    if (typeof input === 'string') {
      consume(stringSize(input));
      return input;
    }
    if (typeof input === 'number' && Number.isFinite(input) && !Object.is(input, -0)) {
      consume(JSON.stringify(input).length);
      return input;
    }
    if (typeof input !== 'object')
      throw new Error('GenerationStore: metadata must be finite JSON data');
    const array = Array.isArray(input);
    const prototype = Object.getPrototypeOf(input);
    if (
      prototype !== (array ? Array.prototype : Object.prototype) &&
      !(prototype === null && !array)
    )
      throw new Error('GenerationStore: unsupported metadata prototype');
    if (ancestors.has(input)) throw new Error('GenerationStore: cyclic metadata');
    ancestors.add(input);
    consume(2);
    try {
      const keys = Reflect.ownKeys(input);
      if (keys.some((key) => typeof key === 'symbol'))
        throw new Error('GenerationStore: metadata symbol keys are unsupported');
      const output: unknown[] | Record<string, unknown> = array ? [] : {};
      if (array && keys.length !== input.length + 1)
        throw new Error('GenerationStore: sparse/extended metadata arrays are unsupported');
      for (const key of keys) {
        if (array && key === 'length') continue;
        if (
          array &&
          (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= input.length)
        )
          throw new Error('GenerationStore: extended metadata arrays are unsupported');
        const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
        if (!descriptor.enumerable || !('value' in descriptor))
          throw new Error('GenerationStore: metadata accessors/nonenumerables are unsupported');
        consume(stringSize(key as string) + 2);
        const copied = clone(descriptor.value, depth + 1);
        Object.defineProperty(output, key, {
          value: copied,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return output;
    } finally {
      ancestors.delete(input);
    }
  };
  return clone(value, 0) as T;
}

/**
 * Stages live eviction writes without changing any published generation. A detached image is
 * published through one backing-store transaction, with immutable blobs and a manifest pointer.
 * Legacy region/session keys are read-only references until the first successful publication.
 */
export class GenerationStore implements BlobStore {
  private readonly backing: BlobStore;
  private readonly stageMutex = new Mutex();
  private readonly publishMutex = new Mutex();
  private references = new Map<string, SaveReference>();
  private dirty = new Map<string, Dirty>();
  private revision = 0;
  private opened = false;
  private generation = 0;
  private overlayBytes = 0;
  private readonly maxOverlayBytes: number;
  private readonly maxCaptureBytes: number;
  private readonly maxKeys: number;
  private readonly retainGenerations: number;
  lastRetentionError: unknown = undefined;
  private latestManifest: ApplicationSaveManifest | null = null;
  private staging = false;
  private readonly captures = new WeakMap<CaptureImage, string>();
  get manifest(): ApplicationSaveManifest | null {
    return this.latestManifest === null
      ? null
      : (JSON.parse(JSON.stringify(this.latestManifest)) as ApplicationSaveManifest);
  }

  constructor(backing: BlobStore, options: GenerationStoreOptions = {}) {
    this.backing = backing;
    this.maxOverlayBytes = options.maxOverlayBytes ?? 64 * 1024 * 1024;
    this.maxCaptureBytes = options.maxCaptureBytes ?? 64 * 1024 * 1024;
    this.maxKeys = options.maxKeys ?? 10_000;
    this.retainGenerations = options.retainGenerations ?? 2;
    for (const limit of [this.maxOverlayBytes, this.maxCaptureBytes, this.maxKeys])
      if (!Number.isSafeInteger(limit) || limit < 1)
        throw new RangeError('GenerationStore: invalid resource limit');
    if (
      !Number.isSafeInteger(this.retainGenerations) ||
      this.retainGenerations < 2 ||
      this.retainGenerations > 100
    )
      throw new RangeError('GenerationStore: retention must be 2..100 generations');
  }

  async open(): Promise<ApplicationSaveManifest | null> {
    if (this.opened) return this.manifest;
    const pointer = await this.backing.get(MANIFEST_NS, 'current');
    if (pointer !== null) {
      const generation: unknown = JSON.parse(decoder.decode(pointer));
      if (!Number.isSafeInteger(generation) || (generation as number) < 1)
        throw new Error('GenerationStore: invalid manifest pointer');
      const bytes = await this.backing.get(MANIFEST_NS, String(generation));
      if (bytes === null) throw new Error('GenerationStore: missing published manifest');
      if (bytes.byteLength > this.maxCaptureBytes)
        throw new Error('GenerationStore: manifest byte limit exceeded');
      const manifest = this.validateManifest(JSON.parse(decoder.decode(bytes)));
      if (manifest.generation !== generation)
        throw new Error('GenerationStore: manifest generation mismatch');
      for (const reference of manifest.entries) await this.readReference(reference);
      this.latestManifest = manifest;
      this.generation = manifest.generation;
      for (const entry of manifest.entries)
        this.references.set(identity(entry.namespace, entry.key), entry);
    } else {
      // Explicit legacy import: original bytes stay untouched and remain usable on failure.
      for (const namespace of ['region', 'session'])
        for (const key of await this.backing.list(namespace)) {
          this.references.set(identity(namespace, key), {
            namespace,
            key,
            blobNamespace: namespace,
            blobKey: key,
          });
        }
      if (this.references.size > this.maxKeys)
        throw new Error('GenerationStore: legacy key limit exceeded');
    }
    this.opened = true;
    return this.manifest;
  }

  async get(namespace: string, key: string): Promise<Uint8Array | null> {
    return this.readView(this.dirty, namespace, key);
  }
  private async readView(
    view: Map<string, Dirty>,
    namespace: string,
    key: string,
  ): Promise<Uint8Array | null> {
    this.assertOpen();
    validateNamespace(namespace);
    validateKey(key);
    const id = identity(namespace, key);
    const staged = view.get(id);
    if (staged) return staged.bytes === null ? null : new Uint8Array(staged.bytes);
    const reference = this.references.get(id);
    if (reference) return this.readReference(reference);
    if (this.generation === 0) {
      const bytes = await this.backing.get(namespace, key);
      if (bytes !== null) {
        if (this.references.size >= this.maxKeys)
          throw new Error('GenerationStore: legacy key limit exceeded');
        this.references.set(id, { namespace, key, blobNamespace: namespace, blobKey: key });
      }
      return bytes;
    }
    return null;
  }

  async put(namespace: string, key: string, bytes: Uint8Array): Promise<void> {
    return this.stageMutex.run(() => this.stage(namespace, key, bytes));
  }
  async delete(namespace: string, key: string): Promise<void> {
    return this.stageMutex.run(() => this.stage(namespace, key, null));
  }
  async list(namespace: string, prefix = ''): Promise<string[]> {
    return this.listView(this.dirty, namespace, prefix);
  }
  private listView(view: Map<string, Dirty>, namespace: string, prefix = ''): string[] {
    this.assertOpen();
    validateNamespace(namespace);
    validateKey(prefix, true);
    const keys = new Set<string>();
    for (const reference of this.references.values())
      if (reference.namespace === namespace && reference.key.startsWith(prefix))
        keys.add(reference.key);
    for (const item of view.values())
      if (item.namespace === namespace && item.key.startsWith(prefix)) {
        if (item.bytes === null) keys.delete(item.key);
        else keys.add(item.key);
      }
    return [...keys].sort(compareKeys);
  }

  transaction<T>(fn: (tx: BlobStore) => T | Promise<T>): Promise<T> {
    return this.stageMutex.run(async () => {
      const view = new Map(this.dirty);
      this.staging = true;
      let active = true;
      const check = () => {
        if (!active) throw new Error('GenerationStore: staging transaction closed');
      };
      const tx: BlobStore = {
        get: async (ns, key) => {
          check();
          return this.readView(view, ns, key);
        },
        put: async (ns, key, bytes) => {
          check();
          this.stageView(view, ns, key, bytes);
        },
        delete: async (ns, key) => {
          check();
          this.stageView(view, ns, key, null);
        },
        list: async (ns, prefix) => {
          check();
          return this.listView(view, ns, prefix);
        },
        transaction: async (nested) => {
          check();
          return nested(tx);
        },
      };
      try {
        const result = await fn(tx);
        this.dirty = view;
        this.overlayBytes = [...view.values()].reduce(
          (sum, item) => sum + (item.bytes?.byteLength ?? 0),
          0,
        );
        return result;
      } finally {
        active = false;
        this.staging = false;
      }
    });
  }

  /** Detaches every byte synchronously at a valid completed tick; caller owns image writes. */
  capture(
    completedTick: number,
    compatibility: unknown,
    writes: readonly SaveWrite[] = [],
    gameSaveVersion = 0,
    stateSchemaHash = 0,
  ): CaptureImage {
    this.assertOpen();
    if (this.staging || this.stageMutex.locked)
      throw new Error('GenerationStore: wait for staging transactions before capture');
    if (!Number.isSafeInteger(gameSaveVersion) || gameSaveVersion < 0)
      throw new Error('GenerationStore: invalid game save version');
    if (!Number.isInteger(stateSchemaHash) || stateSchemaHash < 0 || stateSchemaHash > 0xffffffff)
      throw new Error('GenerationStore: invalid registry hash');
    if (!Number.isSafeInteger(completedTick) || completedTick < 0)
      throw new Error('GenerationStore: invalid capture tick');
    const merged = new Map<string, SaveWrite>();
    const revisions: CaptureImage['revisions'] = [];
    for (const item of this.dirty.values()) {
      merged.set(identity(item.namespace, item.key), {
        namespace: item.namespace,
        key: item.key,
        bytes: item.bytes,
      });
      revisions.push({ namespace: item.namespace, key: item.key, revision: item.revision });
    }
    for (const write of writes) {
      validateNamespace(write.namespace);
      validateKey(write.key);
      if (write.bytes !== null) validateValue(write.bytes);
      merged.set(identity(write.namespace, write.key), {
        ...write,
        bytes: write.bytes,
      });
    }
    const values = [...merged.values()];
    const detachedCompatibility: unknown = detachedJson(
      compatibility ?? null,
      this.maxCaptureBytes,
    );
    const metadataBytes = encoder.encode(
      JSON.stringify({
        compatibility: detachedCompatibility,
        references: [...this.references.values()],
        revisions,
      }),
    ).byteLength;
    if (
      values.length + this.references.size > this.maxKeys * 2 ||
      metadataBytes + values.reduce((sum, item) => sum + (item.bytes?.byteLength ?? 0), 0) >
        this.maxCaptureBytes
    )
      throw new Error('GenerationStore: capture resource limit exceeded');
    const detached = values.map((write) => ({
      ...write,
      bytes: write.bytes === null ? null : new Uint8Array(write.bytes),
    }));
    const image: CaptureImage = {
      kind: 'app-world',
      version: 1,
      baseGeneration: this.generation,
      completedTick,
      compatibility: detachedCompatibility,
      gameSaveVersion,
      stateSchemaHash,
      references: [...this.references.values()].map((entry) => ({ ...entry })),
      writes: detached,
      revisions,
    };
    this.captures.set(image, this.imageSignature(image));
    return image;
  }

  /** Reads only the immutable references detached in image, never the advancing live overlay. */
  async readCaptured(
    image: CaptureImage,
    namespace: string,
    key: string,
  ): Promise<Uint8Array | null> {
    this.validateImage(image);
    const write = image.writes.find((entry) => entry.namespace === namespace && entry.key === key);
    if (write) return write.bytes === null ? null : new Uint8Array(write.bytes);
    const reference = image.references.find(
      (entry) => entry.namespace === namespace && entry.key === key,
    );
    return reference ? this.readReference(reference) : null;
  }

  async publish(image: CaptureImage): Promise<ApplicationSaveManifest> {
    // Capture images deliberately expose caller-owned writes for migration. Once publication
    // starts, own every field before waiting for the publication mutex or backing-store I/O.
    this.validateImage(image);
    if (image.writes.length > this.maxKeys * 2)
      throw new Error('GenerationStore: publication resource limit exceeded');
    let bytes = 0;
    const writes = image.writes.map((write) => {
      validateNamespace(write.namespace);
      validateKey(write.key);
      if (write.bytes !== null) validateValue(write.bytes);
      bytes += write.bytes?.byteLength ?? 0;
      if (bytes > this.maxCaptureBytes)
        throw new Error('GenerationStore: publication resource limit exceeded');
      return { ...write, bytes: write.bytes === null ? null : new Uint8Array(write.bytes) };
    });
    image = {
      ...image,
      compatibility: detachedJson(image.compatibility, this.maxCaptureBytes),
      references: image.references.map((reference) => ({ ...reference })),
      revisions: image.revisions.map((revision) => ({ ...revision })),
      writes,
    };
    this.captures.set(image, this.imageSignature(image));
    return this.publishMutex.run(async () => {
      if (this.lastRetentionError !== undefined) {
        try {
          await this.collectRetainedGenerations();
          this.lastRetentionError = undefined;
        } catch (cause) {
          this.lastRetentionError = cause;
          throw new Error(
            'GenerationStore: retention cleanup must recover before another publication',
            { cause },
          );
        }
      }
      this.validateImage(image);
      if (
        image.kind !== 'app-world' ||
        image.version !== 1 ||
        image.baseGeneration !== this.generation
      )
        throw new Error('GenerationStore: stale or unsupported capture image');
      const generation = this.generation + 1;
      if (!Number.isSafeInteger(generation))
        throw new Error('GenerationStore: generation counter exhausted');
      const references = new Map(
        image.references.map((entry) => [identity(entry.namespace, entry.key), { ...entry }]),
      );
      const blobs: { key: string; bytes: Uint8Array }[] = [];
      let publicationBytes = encoder.encode(
        JSON.stringify(detachedJson(image.compatibility, this.maxCaptureBytes)),
      ).byteLength;
      const append = (key: string, bytes: Uint8Array, copy: boolean) => {
        if (
          blobs.length >= this.maxKeys * 2 ||
          bytes.byteLength > this.maxCaptureBytes - publicationBytes
        )
          throw new Error('GenerationStore: publication resource limit exceeded');
        publicationBytes += bytes.byteLength;
        blobs.push({ key, bytes: copy ? new Uint8Array(bytes) : bytes });
      };
      // A published generation never references mutable legacy region/session keys.
      for (const [id, reference] of references) {
        const bytes = await this.readReference(reference);
        if (reference.blobNamespace !== DATA_NS) {
          const key = `${generation}/${blobs.length}`;
          append(key, bytes, false);
          references.set(id, {
            namespace: reference.namespace,
            key: reference.key,
            blobNamespace: DATA_NS,
            blobKey: key,
            byteLength: bytes.byteLength,
          });
        }
      }
      for (const write of image.writes) {
        validateNamespace(write.namespace);
        validateKey(write.key);
        if (write.bytes !== null) validateValue(write.bytes);
        const id = identity(write.namespace, write.key);
        if (write.bytes === null) references.delete(id);
        else {
          const key = `${generation}/${blobs.length}`;
          append(key, write.bytes, false);
          references.set(id, {
            namespace: write.namespace,
            key: write.key,
            blobNamespace: DATA_NS,
            blobKey: key,
            byteLength: write.bytes.byteLength,
          });
        }
      }
      if (
        references.size > this.maxKeys ||
        blobs.reduce((sum, blob) => sum + blob.bytes.byteLength, 0) > this.maxCaptureBytes
      )
        throw new Error('GenerationStore: publication resource limit exceeded');
      const manifest: ApplicationSaveManifest = {
        kind: 'app-world',
        version: 1,
        generation,
        completedTick: image.completedTick,
        compatibility: image.compatibility,
        gameSaveVersion: image.gameSaveVersion,
        stateSchemaHash: image.stateSchemaHash,
        entries: [...references.values()].sort(
          (a, b) => compareKeys(a.namespace, b.namespace) || compareKeys(a.key, b.key),
        ),
      };
      const manifestBytes = encoder.encode(JSON.stringify(manifest));
      if (manifestBytes.byteLength > this.maxCaptureBytes)
        throw new Error('GenerationStore: manifest byte limit exceeded');
      if (
        manifestBytes.byteLength + blobs.reduce((sum, blob) => sum + blob.bytes.byteLength, 0) >
        this.maxCaptureBytes
      )
        throw new Error('GenerationStore: combined publication byte limit exceeded');
      if (
        manifestBytes.byteLength +
          [...references.values()].reduce(
            (sum, reference) => sum + (reference.byteLength ?? this.maxCaptureBytes + 1),
            0,
          ) >
        this.maxCaptureBytes
      )
        throw new Error('GenerationStore: complete generation byte limit exceeded');
      await this.backing.transaction(async (tx) => {
        for (const blob of blobs) await tx.put(DATA_NS, blob.key, blob.bytes);
        await tx.put(MANIFEST_NS, String(generation), manifestBytes);
        await tx.put(MANIFEST_NS, 'current', encoder.encode(JSON.stringify(generation)));
      });
      await this.stageMutex.run(() => {
        this.references = references;
        this.generation = generation;
        this.latestManifest = detachedJson(manifest);
        for (const acknowledged of image.revisions) {
          const id = identity(acknowledged.namespace, acknowledged.key);
          const staged = this.dirty.get(id);
          if (staged?.revision === acknowledged.revision) {
            this.overlayBytes -= staged.bytes?.byteLength ?? 0;
            this.dirty.delete(id);
          }
        }
      });
      // Retention failure cannot undo an already committed publication. Preserve extra history
      // and report pressure; retry cleanup on the next successful publication.
      try {
        await this.collectRetainedGenerations();
        this.lastRetentionError = undefined;
      } catch (cause) {
        this.lastRetentionError = cause;
      }
      return this.manifest!;
    });
  }

  private stage(namespace: string, key: string, bytes: Uint8Array | null): void {
    this.stageView(this.dirty, namespace, key, bytes);
    this.overlayBytes = [...this.dirty.values()].reduce(
      (sum, item) => sum + (item.bytes?.byteLength ?? 0),
      0,
    );
  }
  private stageView(
    view: Map<string, Dirty>,
    namespace: string,
    key: string,
    bytes: Uint8Array | null,
  ): void {
    this.assertOpen();
    validateNamespace(namespace);
    validateKey(key);
    if (bytes !== null) validateValue(bytes);
    const id = identity(namespace, key);
    const previous = view.get(id);
    const size =
      [...view.values()].reduce((sum, item) => sum + (item.bytes?.byteLength ?? 0), 0) -
      (previous?.bytes?.byteLength ?? 0) +
      (bytes?.byteLength ?? 0);
    if (size > this.maxOverlayBytes || (!previous && view.size >= this.maxKeys))
      throw new Error('GenerationStore: overlay resource limit exceeded');
    view.set(id, {
      namespace,
      key,
      bytes: bytes === null ? null : new Uint8Array(bytes),
      revision: ++this.revision,
    });
  }
  private async readReference(reference: SaveReference): Promise<Uint8Array> {
    const bytes = await this.backing.get(reference.blobNamespace, reference.blobKey);
    if (bytes === null)
      throw new SaveCorruptionError(
        `GenerationStore: missing referenced blob ${reference.namespace}/${reference.key}`,
      );
    try {
      validateValue(bytes);
    } catch (cause) {
      throw new SaveCorruptionError('GenerationStore: invalid referenced blob', { cause });
    }
    if (bytes.byteLength > this.maxCaptureBytes)
      throw new SaveCorruptionError('GenerationStore: referenced blob byte limit exceeded');
    if (reference.byteLength !== undefined && bytes.byteLength !== reference.byteLength)
      throw new SaveCorruptionError('GenerationStore: referenced blob size mismatch');
    return bytes;
  }
  private validateImage(image: CaptureImage): void {
    const signature = this.captures.get(image);
    if (signature === undefined || signature !== this.imageSignature(image))
      throw new Error('GenerationStore: unrecognized or modified capture metadata');
  }
  private imageSignature(image: CaptureImage): string {
    return JSON.stringify([
      image.baseGeneration,
      image.completedTick,
      detachedJson(image.compatibility),
      image.gameSaveVersion,
      image.stateSchemaHash,
      image.references,
      image.revisions,
    ]);
  }
  private async collectRetainedGenerations(): Promise<void> {
    const keys = (await this.backing.list(MANIFEST_NS))
      .filter((key) => /^[1-9][0-9]*$/.test(key))
      .sort((a, b) => Number(b) - Number(a));
    const retained = keys.slice(0, this.retainGenerations);
    const referenced = new Set<string>();
    for (const key of retained) {
      const bytes = await this.backing.get(MANIFEST_NS, key);
      if (bytes === null) throw new Error('GenerationStore: retained manifest disappeared');
      const manifest = this.validateManifest(JSON.parse(decoder.decode(bytes)));
      for (const reference of manifest.entries) referenced.add(reference.blobKey);
    }
    const obsoleteData = (await this.backing.list(DATA_NS)).filter((key) => !referenced.has(key));
    if (obsoleteData.length === 0 && keys.length === retained.length) return;
    await this.backing.transaction(async (tx) => {
      for (const key of keys.slice(this.retainGenerations)) await tx.delete(MANIFEST_NS, key);
      for (const key of obsoleteData) await tx.delete(DATA_NS, key);
    });
  }
  private assertOpen(): void {
    if (!this.opened) throw new Error('GenerationStore: open before use');
  }
  private validateManifest(value: unknown): ApplicationSaveManifest {
    const manifest = value as ApplicationSaveManifest | null;
    if (
      !manifest ||
      manifest.kind !== 'app-world' ||
      manifest.version !== 1 ||
      !Number.isSafeInteger(manifest.generation) ||
      manifest.generation < 1 ||
      !Number.isSafeInteger(manifest.completedTick) ||
      manifest.completedTick < 0 ||
      !Number.isSafeInteger(manifest.gameSaveVersion) ||
      manifest.gameSaveVersion < 0 ||
      !Number.isInteger(manifest.stateSchemaHash) ||
      manifest.stateSchemaHash < 0 ||
      manifest.stateSchemaHash > 0xffffffff ||
      !Array.isArray(manifest.entries) ||
      manifest.entries.length > this.maxKeys
    )
      throw new Error('GenerationStore: unsupported or malformed manifest');
    const names = new Set<string>();
    for (const entry of manifest.entries) {
      if (
        !entry ||
        typeof entry.namespace !== 'string' ||
        typeof entry.key !== 'string' ||
        typeof entry.blobNamespace !== 'string' ||
        typeof entry.blobKey !== 'string'
      )
        throw new Error('GenerationStore: invalid manifest entry');
      validateNamespace(entry.namespace);
      validateKey(entry.key);
      validateNamespace(entry.blobNamespace);
      validateKey(entry.blobKey);
      const id = identity(entry.namespace, entry.key);
      if (names.has(id)) throw new Error('GenerationStore: duplicate manifest entry');
      names.add(id);
      if (
        entry.blobNamespace !== DATA_NS ||
        !/^[1-9][0-9]*\/[0-9]+$/.test(entry.blobKey) ||
        !Number.isSafeInteger(entry.byteLength) ||
        entry.byteLength! < 0 ||
        entry.byteLength! > this.maxCaptureBytes
      )
        throw new Error('GenerationStore: invalid immutable blob reference');
      if (Number(entry.blobKey.split('/')[0]) > manifest.generation)
        throw new Error('GenerationStore: future blob reference');
    }
    detachedJson(manifest.compatibility, this.maxCaptureBytes);
    if (
      encoder.encode(JSON.stringify(manifest)).byteLength +
        manifest.entries.reduce((sum, entry) => sum + entry.byteLength!, 0) >
      this.maxCaptureBytes
    )
      throw new Error('GenerationStore: complete generation byte limit exceeded');
    return manifest;
  }
}

/** Manifest-aware reader for operators/consumers; scope is the host session ID when applicable. */
export async function openApplicationSave(
  backing: BlobStore,
  options: GenerationStoreOptions & { scope?: string } = {},
): Promise<GenerationStore> {
  const prefix = options.scope === undefined ? '' : `${options.scope}/`;
  if (prefix !== '') validateKey(prefix);
  const scoped = (store: BlobStore): BlobStore => ({
    get: (ns, key) => store.get(ns, prefix + key),
    put: (ns, key, value) => store.put(ns, prefix + key, value),
    delete: (ns, key) => store.delete(ns, prefix + key),
    list: async (ns, start = '') =>
      (await store.list(ns, prefix + start)).map((key) => key.slice(prefix.length)),
    transaction: (fn) => store.transaction((tx) => fn(scoped(tx))),
  });
  const save = new GenerationStore(prefix === '' ? backing : scoped(backing), options);
  await save.open();
  return save;
}
