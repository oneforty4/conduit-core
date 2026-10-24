import { validateValue } from './keys.ts';

/** Game-owned application bytes have their own version, separate from framework manifest v1. */
export interface GameSaveMigration {
  /** Migrates version-1 to version. Entries must be contiguous from 1. */
  version: number;
  migrate(previous: Uint8Array): Uint8Array;
}
export interface GameSaveSchema {
  version: number;
  migrations: readonly GameSaveMigration[];
  /** Must validate the declared version before and after each step, including legacy version 0. */
  validate(version: number, bytes: Uint8Array): void;
}

export function validateGameSaveSchema(schema: GameSaveSchema): void {
  if (
    !Number.isSafeInteger(schema.version) ||
    schema.version < 0 ||
    !Array.isArray(schema.migrations) ||
    schema.migrations.length !== schema.version ||
    typeof schema.validate !== 'function'
  )
    throw new Error('Game save: invalid migration schema/version');
  for (let index = 0; index < schema.migrations.length; index++)
    if (
      schema.migrations[index]?.version !== index + 1 ||
      typeof schema.migrations[index]?.migrate !== 'function'
    )
      throw new Error('Game save: migrations must be contiguous from version 1');
}

export function migrateGameSave(
  original: Uint8Array,
  fromVersion: number,
  schema: GameSaveSchema,
): Uint8Array {
  validateGameSaveSchema(schema);
  if (!Number.isSafeInteger(fromVersion) || fromVersion < 0)
    throw new Error('Game save: invalid stored version');
  if (fromVersion > schema.version)
    throw new Error(
      `Game save: stored version ${fromVersion} is newer than supported ${schema.version}`,
    );
  let bytes = new Uint8Array(original);
  validateValue(bytes);
  schema.validate(fromVersion, new Uint8Array(bytes));
  for (let version = fromVersion + 1; version <= schema.version; version++) {
    const next = schema.migrations[version - 1]!.migrate(new Uint8Array(bytes));
    validateValue(next);
    bytes = new Uint8Array(next);
    schema.validate(version, new Uint8Array(bytes));
  }
  return bytes;
}
