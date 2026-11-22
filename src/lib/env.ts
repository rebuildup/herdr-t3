/**
 * Surface flags for the renderer. The desktop app exposes the preload bridge
 * as `window.herdrT3`; the dev browser build has no such global.
 */
export const isElectron =
  typeof globalThis !== "undefined" &&
  (globalThis as { herdrT3?: unknown }).herdrT3 !== undefined;
