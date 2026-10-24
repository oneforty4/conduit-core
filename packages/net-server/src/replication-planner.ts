import {
  ByteWriter,
  encodeSnapshot,
  encodeWith,
  fieldMaskBytes,
  REGION_IDX_NONE,
  SNAPSHOT_FLAG_FULL,
  SNAPSHOT_FLAG_MASKED,
  SNAPSHOT_FLAG_STATE_TICKS,
  type EntityId,
  type Schema,
  type SnapshotComponent,
  type SnapshotData,
  type SnapshotCreate,
  type SnapshotUpdate,
} from '@conduit/protocol';
import type { ReplicationState, SnapshotHeaderFields, SnapshotSource } from './snapshot-builder.ts';

export interface ReplicationGroup {
  key: string;
  entities: readonly EntityId[];
  required?: boolean;
}
export interface ReplicationPolicy {
  groups?: readonly ReplicationGroup[];
  priority?: (group: ReplicationGroup) => number;
}
export interface ReplicationOptions {
  bytesPerSecond?: number;
  burstBytes?: number;
  maxFrameBytes?: number;
  maxCacheBytes?: number;
  maxEntities?: number;
  maxGroups?: number;
  maxGroupBytes?: number;
  fairnessEvery?: number;
  heartbeatTicks?: number;
  controlBytesPerSecond?: number;
  controlBurstBytes?: number;
  controlMaxFrameBytes?: number;
}
export interface PlannerLimits {
  maxCacheBytes: number;
  maxEntities: number;
  maxGroups: number;
  maxGroupBytes: number;
  fairnessEvery: number;
  heartbeatTicks: number;
}
export class ReplicationCapacityError extends Error {
  override readonly name = 'ReplicationCapacityError';
}
interface WireComponent {
  version: number;
  whole: Uint8Array;
  fields: readonly Uint8Array[];
  bytes: number;
}
interface WireEntity {
  tick: number;
  components: Map<number, WireComponent>;
}
interface Candidate {
  group: ReplicationGroup;
  since: number;
  score: number;
  creates: SnapshotCreate[];
  updates: SnapshotUpdate[];
  images: Map<EntityId, WireEntity>;
  destroys: number[];
  cost: number;
}
export interface PreparedReplication {
  data: SnapshotData;
  bytes: Uint8Array;
  entities: ReadonlySet<EntityId>;
  deferred: number;
  oldestDeferredTicks: number;
  commit(): void;
}
const equal = (a: Uint8Array, b: Uint8Array) =>
  a.byteLength === b.byteLength && a.every((byte, index) => byte === b[index]);
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Per-client wire images; dirty discovery never uses a global last-snapshot watermark. */
export class ReplicationPlanner {
  private wire = new Map<EntityId, WireEntity>();
  private pendingSince = new Map<string, number>();
  private rounds = 0;
  private previousGroups = new Map<EntityId, readonly EntityId[]>();
  private readonly limits: PlannerLimits;
  constructor(options: ReplicationOptions = {}) {
    this.limits = {
      maxCacheBytes: options.maxCacheBytes ?? 16 * 1024 * 1024,
      maxEntities: options.maxEntities ?? 65535,
      maxGroups: options.maxGroups ?? 8192,
      maxGroupBytes: options.maxGroupBytes ?? 128 * 1024,
      fairnessEvery: options.fairnessEvery ?? 4,
      heartbeatTicks: options.heartbeatTicks ?? 60,
    };
    for (const [name, value] of Object.entries(this.limits))
      if (!Number.isSafeInteger(value) || value < 1)
        throw new RangeError(`Replication: invalid ${name}`);
    if (
      this.limits.maxEntities > 65535 ||
      this.limits.maxGroups > 65535 ||
      this.limits.maxGroupBytes > 16 * 1024 * 1024 ||
      this.limits.maxCacheBytes > 256 * 1024 * 1024 ||
      this.limits.fairnessEvery < 2 ||
      this.limits.fairnessEvery > 64
    )
      throw new RangeError('Replication: unsupported cache/group bounds');
  }
  reset(): void {
    this.wire.clear();
    this.pendingSince.clear();
    this.previousGroups.clear();
    this.rounds = 0;
  }
  stats(): {
    entities: number;
    components: number;
    cacheBytes: number;
    groups: number;
    pendingGroups: number;
  } {
    let components = 0,
      cacheBytes = 0;
    for (const entity of this.wire.values())
      for (const component of entity.components.values()) {
        components++;
        cacheBytes += component.bytes;
      }
    return {
      entities: this.wire.size,
      components,
      cacheBytes,
      groups: new Set(this.previousGroups.values()).size,
      pendingGroups: this.pendingSince.size,
    };
  }

  prepare(
    source: SnapshotSource,
    state: ReplicationState,
    regions: Iterable<string>,
    tick: number,
    header: SnapshotHeaderFields,
    targetBytes: number,
    maxBytes: number,
    policy: ReplicationPolicy = {},
  ): PreparedReplication {
    if (state.fullNext) this.reset();
    const eligible = new Set<number>();
    for (const region of regions)
      for (const entity of source.entitiesIn(region))
        if (source.relevance?.(entity) !== false) eligible.add(entity);
    if (eligible.size > this.limits.maxEntities)
      throw new ReplicationCapacityError(
        'Replication: eligible entity count exceeds configured maxEntities',
      );
    const covered = new Set<number>();
    const keys = new Set<string>();
    const groups: ReplicationGroup[] = [];
    for (const group of policy.groups ?? []) {
      if (
        typeof group.key !== 'string' ||
        group.key.startsWith('entity/') ||
        group.key.startsWith('lifecycle/') ||
        group.key.length < 1 ||
        new TextEncoder().encode(group.key).byteLength > 64 ||
        keys.has(group.key) ||
        group.entities.length < 1 ||
        group.entities.length > this.limits.maxEntities
      )
        throw new ReplicationCapacityError('Replication: invalid/duplicate dependency group');
      const entities = [...group.entities].sort((a, b) => a - b);
      for (const entity of entities) {
        if (
          covered.has(entity) ||
          (!eligible.has(entity) &&
            source.entityAlive?.(entity) !== false &&
            (!state.known.has(entity) || !this.previousGroups.has(entity)))
        )
          throw new ReplicationCapacityError(
            'Replication: dependency group overlaps or includes an ineligible entity',
          );
        covered.add(entity);
      }
      keys.add(group.key);
      groups.push({
        key: group.key,
        entities: entities.filter((entity) => eligible.has(entity)),
        ...(group.required ? { required: true } : {}),
      });
    }
    for (const entity of [...eligible].sort((a, b) => a - b))
      if (!covered.has(entity)) groups.push({ key: `entity/${entity}`, entities: [entity] });
    if (groups.length > this.limits.maxGroups)
      throw new ReplicationCapacityError('Replication: group count exceeds configured maxGroups');
    const destroyed = new Set(
      state.fullNext ? [] : [...state.known].filter((entity) => !eligible.has(entity)),
    );
    const componentIds = source.registry.replicated.map((component) =>
      source.registry.componentId(component),
    );
    const candidates: Candidate[] = [];
    let cacheBytes = 0;
    for (const group of groups) {
      const creates: SnapshotCreate[] = [];
      const updates: SnapshotUpdate[] = [];
      const images = new Map<number, WireEntity>();
      let dirty = false;
      for (const entity of group.entities) {
        const previous = state.fullNext ? undefined : this.wire.get(entity);
        const components = new Map<number, WireComponent>();
        const changed: SnapshotComponent[] = [];
        const removed: number[] = [];
        const slot = source.slot(entity);
        for (const id of componentIds) {
          const store = source.store(id);
          const prior = previous?.components.get(id);
          if (!store.has(entity)) {
            if (prior) {
              removed.push(id);
              dirty = true;
            }
            continue;
          }
          const version = store.version[slot] ?? 0;
          const definition = source.registry.component(id)!;
          let image = prior;
          let raw: unknown;
          if (prior === undefined || prior.version !== version) {
            raw = store.read(entity);
            const writer = new ByteWriter();
            encodeWith(writer, definition.schema, raw);
            const whole = new Uint8Array(writer.view());
            if (whole.byteLength > this.limits.maxGroupBytes)
              throw new ReplicationCapacityError(
                `Replication: component ${definition.name} exceeds configured maxGroupBytes`,
              );
            const fields: Uint8Array[] = [];
            if (fieldMaskBytes(definition.schema) > 0)
              for (const name of definition.schema.fieldNames) {
                writer.reset();
                definition.schema.fields[name]!.encode(
                  writer,
                  (raw as Record<string, unknown>)[name],
                );
                fields.push(new Uint8Array(writer.view()));
              }
            image = {
              version,
              whole,
              fields,
              bytes: whole.byteLength + fields.reduce((sum, field) => sum + field.byteLength, 0),
            };
          }
          components.set(id, image!);
          cacheBytes += image!.bytes;
          if (cacheBytes > this.limits.maxCacheBytes)
            throw new ReplicationCapacityError('Replication: wire cache byte limit exceeded');
          if (prior === undefined || !equal(prior.whole, image!.whole)) {
            dirty = true;
            raw ??= store.read(entity);
            const schema = definition.schema;
            if (previous === undefined || prior === undefined || fieldMaskBytes(schema) === 0)
              changed.push({ id, value: this.copy(schema, raw) });
            else {
              let mask = 0;
              const value: Record<string, unknown> = {};
              for (let field = 0; field < schema.fieldNames.length; field++)
                if (!equal(prior.fields[field]!, image!.fields[field]!)) {
                  mask |= 1 << field;
                  const name = schema.fieldNames[field]!;
                  const type = schema.fields[name]!;
                  value[name] = type.copy((raw as Record<string, unknown>)[name], type.create());
                }
              changed.push({ id, mask, value });
            }
          }
        }
        images.set(entity, { tick, components });
        if (previous === undefined)
          creates.push({
            entity,
            stateTick: tick,
            regionIdx: REGION_IDX_NONE,
            components: changed,
          });
        else updates.push({ entity, stateTick: tick, components: changed, removed });
      }
      const heartbeat = group.entities.some(
        (entity) => tick - (this.wire.get(entity)?.tick ?? 0) >= this.limits.heartbeatTicks,
      );
      const affectedByRemoval = group.entities.some((entity) =>
        this.previousGroups.get(entity)?.some((member) => destroyed.has(member)),
      );
      if (
        group.entities.length === 0 ||
        (!dirty && !group.required && !heartbeat && !state.fullNext && !affectedByRemoval)
      )
        continue;
      const since = this.pendingSince.get(group.key) ?? tick;
      this.pendingSince.set(group.key, since);
      const score = policy.priority?.(group) ?? 0;
      if (!Number.isFinite(score) || Math.abs(score) > 1_000_000)
        throw new ReplicationCapacityError(
          'Replication: priority must be finite in -1000000..1000000',
        );
      const candidate: Candidate = {
        group,
        since,
        score,
        creates,
        updates,
        images,
        destroys: [],
        cost: 0,
      };
      const sample = this.data(tick, header, state, creates, updates, [], source);
      const writer = new ByteWriter();
      encodeSnapshot(writer, source.registry, sample);
      candidate.cost = writer.length;
      if (!state.fullNext && candidate.cost > this.limits.maxGroupBytes)
        throw new ReplicationCapacityError(
          `Replication: dependency group ${group.key} exceeds maxGroupBytes`,
        );
      candidates.push(candidate);
    }
    // Prior dependency membership joins removals/relevance loss to all surviving members.
    const byEntity = new Map<number, Candidate>();
    for (const candidate of candidates)
      for (const entity of candidate.group.entities) byEntity.set(entity, candidate);
    type Lifecycle = {
      candidates: Set<Candidate>;
      destroys: Set<number>;
      parent: Lifecycle | null;
    };
    const roots: Lifecycle[] = [];
    const byPreviousGroup = new Map<readonly number[], Lifecycle>();
    const owner = new Map<Candidate, Lifecycle>();
    const find = (unit: Lifecycle): Lifecycle => {
      let root = unit;
      while (root.parent !== null) root = root.parent;
      while (unit.parent !== null) {
        const next = unit.parent;
        unit.parent = root;
        unit = next;
      }
      return root;
    };
    const join = (left: Lifecycle, right: Lifecycle): Lifecycle => {
      left = find(left);
      right = find(right);
      if (left === right) return left;
      if (left.candidates.size + left.destroys.size < right.candidates.size + right.destroys.size)
        [left, right] = [right, left];
      right.parent = left;
      for (const candidate of right.candidates) left.candidates.add(candidate);
      for (const entity of right.destroys) left.destroys.add(entity);
      return left;
    };
    for (const entity of [...destroyed].sort((a, b) => a - b)) {
      const members = this.previousGroups.get(entity) ?? [entity];
      let unit = byPreviousGroup.get(members);
      if (unit === undefined) {
        unit = { candidates: new Set(), destroys: new Set(), parent: null };
        roots.push(unit);
        byPreviousGroup.set(members, unit);
      }
      unit = find(unit);
      for (const member of members) {
        const candidate = byEntity.get(member);
        if (candidate === undefined) continue;
        const existing = owner.get(candidate);
        if (existing !== undefined) unit = join(unit, existing);
        unit.candidates.add(candidate);
        owner.set(candidate, unit);
      }
      unit.destroys.add(entity);
    }
    const lifecycle = [...new Set(roots.map(find))];
    const replaced = new Set(lifecycle.flatMap((unit) => [...unit.candidates]));
    const scheduling = candidates.filter((candidate) => !replaced.has(candidate));
    for (const unit of lifecycle) {
      const originals = [...unit.candidates];
      const removed = [...unit.destroys].sort((a, b) => a - b);
      const key = `lifecycle/${removed[0]}`;
      const entities = [
        ...new Set(originals.flatMap((candidate) => [...candidate.group.entities])),
      ].sort((a, b) => a - b);
      const candidate: Candidate = {
        group: { key, entities, required: originals.some((candidate) => candidate.group.required) },
        since: this.pendingSince.get(key) ?? tick,
        score: 1_000_000,
        creates: originals.flatMap((candidate) => candidate.creates),
        updates: originals.flatMap((candidate) => candidate.updates),
        images: new Map(originals.flatMap((candidate) => [...candidate.images])),
        destroys: removed,
        cost: 0,
      };
      this.pendingSince.set(key, candidate.since);
      const writer = new ByteWriter();
      encodeSnapshot(
        writer,
        source.registry,
        this.data(tick, header, state, candidate.creates, candidate.updates, removed, source),
      );
      candidate.cost = writer.length;
      if (candidate.cost > this.limits.maxGroupBytes)
        throw new ReplicationCapacityError(
          'Replication: removal and surviving dependency group exceed maxGroupBytes',
        );
      scheduling.push(candidate);
    }
    const currentKeys = new Set([
      ...groups.map((group) => group.key),
      ...scheduling.map((candidate) => candidate.group.key),
    ]);
    for (const key of this.pendingSince.keys())
      if (!currentKeys.has(key)) this.pendingSince.delete(key);
    scheduling.sort(
      (a, b) =>
        Number(b.group.required === true) - Number(a.group.required === true) ||
        (a.group.required && b.group.required ? a.since - b.since : 0) ||
        Number(b.destroys.length > 0) - Number(a.destroys.length > 0) ||
        b.score - a.score ||
        a.since - b.since ||
        compare(a.group.key, b.group.key),
    );
    const aged = [...scheduling]
      .filter((candidate) => !candidate.group.required)
      .sort((a, b) => a.since - b.since || compare(a.group.key, b.group.key))[0];
    if (aged && this.rounds % this.limits.fairnessEvery === 0) {
      const index = scheduling.indexOf(aged);
      scheduling.splice(index, 1);
      scheduling.unshift(aged);
    }

    const selected: Candidate[] = [];
    let size = 32;
    const imageBytes = (image: WireEntity | undefined): number =>
      image === undefined
        ? 0
        : [...image.components.values()].reduce((sum, component) => sum + component.bytes, 0);
    let retainedEntities = state.fullNext ? 0 : this.wire.size;
    let retainedBytes = state.fullNext
      ? 0
      : [...this.wire.values()].reduce((sum, image) => sum + imageBytes(image), 0);
    for (const candidate of scheduling) {
      if (!(
        state.fullNext ||
        (candidate === aged && this.rounds % this.limits.fairnessEvery === 0) ||
        selected.length === 0 ||
        size + candidate.cost <= targetBytes
      ))
        continue;
      let added = 0,
        removed = 0,
        bytes = 0;
      for (const [entity, image] of candidate.images) {
        const previous = state.fullNext ? undefined : this.wire.get(entity);
        if (previous === undefined) added++;
        bytes += imageBytes(image) - imageBytes(previous);
      }
      for (const entity of candidate.destroys) {
        const previous = this.wire.get(entity);
        if (previous !== undefined) {
          removed++;
          bytes -= imageBytes(previous);
        }
      }
      if (
        retainedEntities + added - removed > this.limits.maxEntities ||
        retainedBytes + bytes > this.limits.maxCacheBytes
      ) {
        if (state.fullNext)
          throw new ReplicationCapacityError('Replication: full image exceeds cache limits');
        continue;
      }
      selected.push(candidate);
      size += candidate.cost;
      retainedEntities += added - removed;
      retainedBytes += bytes;
    }
    const make = () =>
      this.data(
        tick,
        header,
        state,
        selected.flatMap((candidate) => candidate.creates),
        selected.flatMap((candidate) => candidate.updates),
        selected.flatMap((candidate) => candidate.destroys).sort((a, b) => a - b),
        source,
      );
    let data = make();
    const writer = new ByteWriter();
    encodeSnapshot(writer, source.registry, data);
    while (writer.length > maxBytes && !state.fullNext && selected.length > 1) {
      selected.pop();
      data = make();
      writer.reset();
      encodeSnapshot(writer, source.registry, data);
    }
    if (writer.length > maxBytes)
      throw new ReplicationCapacityError(
        'Replication: indivisible coherent transaction exceeds negotiated maximum bytes',
      );
    const selectedKeys = new Set(selected.map((candidate) => candidate.group.key));
    const deferred = scheduling.filter((candidate) => !selectedKeys.has(candidate.group.key));
    const entities = new Set(selected.flatMap((candidate) => [...candidate.group.entities]));
    return {
      data,
      bytes: new Uint8Array(writer.view()),
      entities,
      deferred: deferred.length,
      oldestDeferredTicks: deferred.reduce(
        (age, candidate) => Math.max(age, tick - candidate.since),
        0,
      ),
      commit: () => {
        if (state.fullNext) {
          state.known.clear();
          this.wire.clear();
          this.previousGroups.clear();
        }
        for (const candidate of selected)
          for (const entity of candidate.destroys) {
            state.known.delete(entity);
            this.wire.delete(entity);
            this.previousGroups.delete(entity);
          }
        for (const candidate of selected) {
          const members = Object.freeze([...candidate.group.entities]);
          for (const [entity, image] of candidate.images) {
            this.wire.set(entity, image);
            state.known.add(entity);
            this.previousGroups.set(entity, members);
          }
          this.pendingSince.delete(candidate.group.key);
        }
        state.baselineTick = tick;
        state.fullNext = false;
        this.rounds++;
      },
    };
  }
  private copy(schema: Schema<unknown>, value: unknown): unknown {
    return schema.copy(value, schema.create());
  }
  private data(
    tick: number,
    header: SnapshotHeaderFields,
    state: ReplicationState,
    creates: SnapshotCreate[],
    updates: SnapshotUpdate[],
    destroys: number[],
    source: SnapshotSource,
  ): SnapshotData {
    const regions: string[] = [];
    const indices = new Map<string, number>();
    const entries = creates.map((create) => {
      const region = source.regionOf(create.entity);
      if (region === null || region === undefined) return create;
      let index = indices.get(region);
      if (index === undefined) {
        index = regions.length;
        regions.push(region);
        indices.set(region, index);
      }
      return { ...create, regionIdx: index };
    });
    return {
      header: {
        serverTick: tick,
        ...header,
        baselineTick: state.fullNext ? 0 : state.baselineTick,
        flags:
          (state.fullNext ? SNAPSHOT_FLAG_FULL : 0) |
          SNAPSHOT_FLAG_MASKED |
          SNAPSHOT_FLAG_STATE_TICKS,
      },
      regions,
      creates: entries,
      updates,
      destroys,
    };
  }
}
