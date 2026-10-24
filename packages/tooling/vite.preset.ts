import { mergeConfig, searchForWorkspaceRoot, type UserConfig } from 'vite';

export interface ConduitViteOptions {
  root?: string; // default process.cwd()
  extraAllow?: string[]; // additional server.fs.allow entries (e.g. a sibling core checkout)
}

export function conduitVite(overrides: UserConfig = {}, opts: ConduitViteOptions = {}): UserConfig {
  const root = opts.root ?? process.cwd();
  const base: UserConfig = {
    resolve: { dedupe: ['three'] },
    optimizeDeps: { include: ['three'], exclude: [] },
    server: { fs: { allow: [searchForWorkspaceRoot(root), '..', ...(opts.extraAllow ?? [])] } },
    build: { target: 'es2022', sourcemap: true },
    esbuild: { target: 'es2022' },
  };
  return mergeConfig(base, overrides);
}
