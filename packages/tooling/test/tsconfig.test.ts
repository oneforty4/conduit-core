import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const toolingDir = fileURLToPath(new URL('..', import.meta.url));
const baseConfigPath = path.join(toolingDir, 'tsconfig.base.json');

function parseConfig(configPath: string, host: ts.ParseConfigHost = ts.sys): ts.ParsedCommandLine {
  const { config, error } = ts.readConfigFile(configPath, (file) => host.readFile(file));
  expect(error).toBeUndefined();
  return ts.parseJsonConfigFileContent(
    config,
    host,
    path.dirname(configPath),
    undefined,
    configPath,
  );
}

function withoutConfigPath({ configFilePath: _path, ...options }: ts.CompilerOptions) {
  return options;
}

describe('tsconfig.base.json', () => {
  const parsed = parseConfig(baseConfigPath);

  it('parses without diagnostics', () => {
    expect(parsed.errors).toEqual([]);
  });

  it('turns on the strict flags', () => {
    const flags = [
      'strict',
      'exactOptionalPropertyTypes',
      'noUncheckedIndexedAccess',
      'noEmit',
      'isolatedModules',
      'verbatimModuleSyntax',
    ] as const;
    for (const flag of flags) expect(parsed.options[flag], flag).toBe(true);
  });

  it('sets types, module resolution and target', () => {
    expect(parsed.options.types).toEqual([]);
    expect(parsed.options.moduleResolution).toBe(ts.ModuleResolutionKind.Bundler);
    expect(parsed.options.target).toBe(ts.ScriptTarget.ES2022);
  });
});

describe('a package tsconfig extending the base by relative path', () => {
  // A virtual packages/fixture beside packages/tooling; the base config itself is read from disk.
  const fixtureDir = path.join(toolingDir, '..', 'fixture');
  const fixtureConfigPath = path.join(fixtureDir, 'tsconfig.json');
  const fixtureSource = path.join(fixtureDir, 'src', 'index.ts');
  const overlay = new Map([
    [
      fixtureConfigPath,
      JSON.stringify({ extends: '../tooling/tsconfig.base.json', include: ['src', 'test'] }),
    ],
    [fixtureSource, 'export {};\n'],
  ]);
  const host: ts.ParseConfigHost = {
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    fileExists: (file) => overlay.has(file) || ts.sys.fileExists(file),
    readFile: (file) => overlay.get(file) ?? ts.sys.readFile(file),
    readDirectory: (root) =>
      [...overlay.keys()].filter((f) => f.startsWith(root) && f.endsWith('.ts')),
  };

  it('resolves the same options as the base', () => {
    const fixture = parseConfig(fixtureConfigPath, host);
    expect(fixture.errors).toEqual([]);
    expect(fixture.fileNames).toEqual([fixtureSource]);
    expect(withoutConfigPath(fixture.options)).toEqual(
      withoutConfigPath(parseConfig(baseConfigPath).options),
    );
    expect(fixture.options.exactOptionalPropertyTypes).toBe(true);
    expect(fixture.options.moduleResolution).toBe(ts.ModuleResolutionKind.Bundler);
  });
});
