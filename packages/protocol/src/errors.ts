export type DecodeErrorCode =
  | 'eof' // read past the end of the reader
  | 'range' // decoded scalar outside its domain (bool > 1, presence flag > 1, bad region index)
  | 'count' // array count > max, region table > MAX_REGION_TABLE
  | 'length' // str byte length > max, payloadLength > remaining, oversized frame, trailing bytes
  | 'utf8' // invalid UTF-8 in str
  | 'varuint' // LEB128 longer than 5 bytes or exceeding u32
  | 'version' // frame wireVersion != WIRE_VERSION
  | 'unknown'; // unknown component/event id inside Snapshot/Events (registry mismatch)

/**
 * Thrown by every decoder. `offset` is the absolute index into the reader's buffer of the first byte
 * of the value that failed to decode (docs/protocol.md 2, 3).
 */
export class DecodeError extends Error {
  override readonly name = 'DecodeError';
  readonly code: DecodeErrorCode;
  readonly offset: number;

  constructor(code: DecodeErrorCode, offset: number, message?: string) {
    super(message ?? `${code} at offset ${offset}`);
    this.code = code;
    this.offset = offset;
  }
}

export type EncodeErrorCode = 'range' | 'length' | 'count' | 'nan' | 'capacity' | 'payload';

/** Thrown by every encoder when a value cannot be represented on the wire. */
export class EncodeError extends Error {
  override readonly name = 'EncodeError';
  readonly code: EncodeErrorCode;

  constructor(code: EncodeErrorCode, message?: string) {
    super(message ?? code);
    this.code = code;
  }
}
