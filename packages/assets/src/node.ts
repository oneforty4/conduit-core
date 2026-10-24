// `@conduit/assets/node` (docs/assets.md §2, §6): Node-only build, check and CLI logic.
export {
  BuildInputError,
  buildManifest,
  expandPatterns,
  idFromPath,
  typeFromExt,
  type BuildOptions,
  type BuildResult,
} from './build.ts';
export { checkManifest, type CheckCode, type CheckFailure, type CheckOptions } from './check.ts';
export { USAGE, cli, type CliIo } from './cli.ts';
