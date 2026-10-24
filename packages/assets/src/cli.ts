import { BuildInputError, buildManifest } from './build.ts';
import { checkManifest } from './check.ts';

export interface CliIo {
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
}

export const USAGE = [
  'conduit-assets build <srcDir> <outDir> [--graph <world.json>] [--base-url </assets/>] [--clean]',
  'conduit-assets check <manifest.json> [--dir <outDir>]',
].join('\n');

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_FAILED = 2;

interface Parsed {
  positionals: string[];
  values: Map<string, string>;
  flags: Set<string>;
}

class UsageError extends Error {}

/** Splits argv into positionals, `--name value` / `--name=value` options, and boolean flags. */
function parseArgs(
  argv: readonly string[],
  valueOptions: readonly string[],
  flagOptions: readonly string[],
): Parsed {
  const parsed: Parsed = { positionals: [], values: new Map(), flags: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (!arg.startsWith('--')) {
      parsed.positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = eq < 0 ? arg.slice(2) : arg.slice(2, eq);
    if (valueOptions.includes(name)) {
      const value = eq < 0 ? argv[++i] : arg.slice(eq + 1);
      if (value === undefined || value === '') throw new UsageError(`--${name} needs a value`);
      parsed.values.set(name, value);
    } else if (flagOptions.includes(name) && eq < 0) {
      parsed.flags.add(name);
    } else {
      throw new UsageError(`unknown option ${arg}`);
    }
  }
  return parsed;
}

function expectPositionals(parsed: Parsed, names: readonly string[], command: string): string[] {
  if (parsed.positionals.length < names.length) {
    throw new UsageError(`${command}: missing ${names.slice(parsed.positionals.length).join(' ')}`);
  }
  if (parsed.positionals.length > names.length) {
    throw new UsageError(
      `${command}: unexpected argument ${parsed.positionals[names.length] ?? ''}`,
    );
  }
  return parsed.positionals;
}

/**
 * The `conduit-assets` command (docs/assets.md §2). Returns the exit code: 0 success, 1 usage
 * (`--help` or a parse error, with usage printed), 2 build, validation or check failure. Failures go
 * to stderr one per line as `<code> <path>: <message>`.
 */
export async function cli(argv: string[], io: CliIo = {}): Promise<number> {
  const stdout = io.stdout ?? ((s: string) => void process.stdout.write(`${s}\n`));
  const stderr = io.stderr ?? ((s: string) => void process.stderr.write(`${s}\n`));
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    stdout(USAGE);
    return EXIT_USAGE;
  }
  const [command, ...rest] = argv;
  let target = '';
  try {
    if (command === 'build') {
      const parsed = parseArgs(rest, ['graph', 'base-url'], ['clean']);
      const [srcDir = '', outDir = ''] = expectPositionals(
        parsed,
        ['<srcDir>', '<outDir>'],
        'build',
      );
      target = srcDir;
      const graphPath = parsed.values.get('graph');
      const baseUrl = parsed.values.get('base-url');
      const result = await buildManifest({
        srcDir,
        outDir,
        ...(graphPath === undefined ? {} : { graphPath }),
        ...(baseUrl === undefined ? {} : { baseUrl }),
        clean: parsed.flags.has('clean'),
        log: stdout,
      });
      for (const e of result.errors) stderr(`${e.code} ${e.path}: ${e.message}`);
      return result.errors.length > 0 ? EXIT_FAILED : EXIT_OK;
    }
    if (command === 'check') {
      const parsed = parseArgs(rest, ['dir'], []);
      const [manifestPath = ''] = expectPositionals(parsed, ['<manifest.json>'], 'check');
      target = manifestPath;
      const dir = parsed.values.get('dir');
      const failures = await checkManifest({
        manifestPath,
        ...(dir === undefined ? {} : { dir }),
        log: stdout,
      });
      for (const f of failures) stderr(`${f.code} ${f.id ?? manifestPath}: ${f.message}`);
      return failures.length > 0 ? EXIT_FAILED : EXIT_OK;
    }
    throw new UsageError(
      command === undefined ? 'missing command' : `unknown command '${command}'`,
    );
  } catch (error) {
    if (error instanceof UsageError) {
      stderr(`error: ${error.message}`);
      stderr(USAGE);
      return EXIT_USAGE;
    }
    if (error instanceof BuildInputError) {
      stderr(`input_error ${error.path}: ${error.message}`);
      return EXIT_FAILED;
    }
    stderr(`io_error ${target}: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT_FAILED;
  }
}
