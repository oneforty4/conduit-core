// A module that is not a game module: `conduit-host` must exit 1 for it (docs/host.md 22).
export const sessionFactory = (): Record<string, never> => ({});
