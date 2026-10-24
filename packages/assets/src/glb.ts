/** Binary glTF container parsing (docs/assets.md §4.1). Isomorphic: no Node APIs. */

export const GLB_MAGIC = 0x46546c67; // 'glTF'
export const GLB_VERSION = 2;
export const GLB_CHUNK_JSON = 0x4e4f534a; // 'JSON'
export const GLB_CHUNK_BIN = 0x004e4942; // 'BIN\0'
export const GLB_HEADER_BYTES = 12;

const CHUNK_HEADER_BYTES = 8;

/** Node fields core reads. `matrix` is column-major. */
export interface GltfNode {
  name?: string;
  mesh?: number;
  children?: number[];
  translation?: [number, number, number];
  rotation?: [number, number, number, number];
  scale?: [number, number, number];
  matrix?: number[];
  extras?: unknown;
}

/** Minimal structural view of the glTF JSON chunk: only the fields core reads are typed. */
export interface GltfJson {
  asset: { version: string; generator?: string };
  scene?: number;
  scenes?: { name?: string; nodes?: number[] }[];
  nodes?: GltfNode[];
  meshes?: { name?: string }[];
  animations?: { name?: string }[];
  buffers?: { uri?: string; byteLength?: number }[];
  images?: { uri?: string }[];
  extensionsRequired?: string[];
  extensionsUsed?: string[];
}

export interface GlbParsed {
  json: GltfJson;
  /** Copy of the first BIN chunk; `null` when absent or with `jsonOnly`. */
  bin: ArrayBuffer | null;
  /** Total length declared by the header. */
  byteLength: number;
}

export type GlbErrorCode = 'bad_magic' | 'bad_version' | 'truncated' | 'no_json_chunk' | 'bad_json';

export class GlbParseError extends Error {
  override readonly name = 'GlbParseError';
  readonly code: GlbErrorCode;

  constructor(code: GlbErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

const hex = (n: number): string => `0x${n.toString(16).padStart(8, '0')}`;

function decodeJson(chunk: Uint8Array): GltfJson {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(chunk);
  } catch {
    throw new GlbParseError('bad_json', 'JSON chunk is not valid UTF-8');
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new GlbParseError('bad_json', `JSON chunk does not parse: ${String(error)}`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new GlbParseError('bad_json', 'JSON chunk is not an object');
  }
  return value as GltfJson;
}

/**
 * Reads a GLB header and its chunks. The first JSON chunk is parsed; the first BIN chunk is copied
 * unless `jsonOnly`, in which case scanning stops after the JSON chunk. Chunk lengths not padded to
 * 4 bytes are tolerated. Throws `GlbParseError`.
 */
export function parseGlb(
  buf: ArrayBuffer | Uint8Array,
  opts: { jsonOnly?: boolean } = {},
): GlbParsed {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const jsonOnly = opts.jsonOnly ?? false;
  if (bytes.byteLength < GLB_HEADER_BYTES) {
    throw new GlbParseError(
      'truncated',
      `${bytes.byteLength} bytes is shorter than the GLB header`,
    );
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = dv.getUint32(0, true);
  if (magic !== GLB_MAGIC) {
    throw new GlbParseError('bad_magic', `bad GLB magic ${hex(magic)}, expected ${hex(GLB_MAGIC)}`);
  }
  const version = dv.getUint32(4, true);
  if (version !== GLB_VERSION) {
    throw new GlbParseError(
      'bad_version',
      `unsupported GLB version ${version}, expected ${GLB_VERSION}`,
    );
  }
  const total = dv.getUint32(8, true);
  if (total > bytes.byteLength) {
    throw new GlbParseError(
      'truncated',
      `header declares ${total} bytes but only ${bytes.byteLength} are present`,
    );
  }

  let off = GLB_HEADER_BYTES;
  let json: GltfJson | null = null;
  let bin: ArrayBuffer | null = null;
  while (off + CHUNK_HEADER_BYTES <= total) {
    const length = dv.getUint32(off, true);
    const type = dv.getUint32(off + 4, true);
    off += CHUNK_HEADER_BYTES;
    if (off + length > total) {
      throw new GlbParseError(
        'truncated',
        `chunk ${hex(type)} at byte ${off - CHUNK_HEADER_BYTES} runs past the end`,
      );
    }
    if (type === GLB_CHUNK_JSON && json === null) {
      json = decodeJson(bytes.subarray(off, off + length));
    } else if (type === GLB_CHUNK_BIN && !jsonOnly && bin === null) {
      const copy = new ArrayBuffer(length);
      new Uint8Array(copy).set(bytes.subarray(off, off + length));
      bin = copy;
    }
    off += length + ((4 - (length % 4)) % 4);
    if (json !== null && jsonOnly) break;
  }
  if (json === null) throw new GlbParseError('no_json_chunk', 'GLB has no JSON chunk');
  return { json, bin, byteLength: total };
}
