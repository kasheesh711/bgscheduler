/**
 * Stand-in for the `server-only` package when a one-shot script imports a
 * module that declares itself server-only.
 *
 * `server-only` is not a dependency of this project — Next resolves it during
 * its own build, and its whole purpose is to fail that build if a server module
 * reaches a client bundle. A `tsx` script has no such resolution, so importing
 * anything under `src/lib` that starts with `import "server-only"` dies with
 * MODULE_NOT_FOUND.
 *
 * Mapping it to this empty module is scoped to `scripts/tsconfig.json` on
 * purpose. Adding the mapping to the root tsconfig would make Next resolve it
 * here too, silently disarming the guard for the entire application.
 */
export {};
