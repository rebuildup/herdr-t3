/*
 * Boot fixture for persistence-compat.test.ts (issue #239). Runs in its
 * own bun process so settings.ts evaluates against a seeded storage —
 * the only way to exercise the real load() path, since bun test shares
 * the module registry across files in one process.
 *
 * Usage: CASE=<case> bun src/lib/persistence-compat.boot.ts
 * Prints JSON { terminal, general } of the loaded settings.
 */

class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  key(index: number) {
    return [...this.map.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
  setItem(key: string, value: string) {
    this.map.set(key, String(value));
  }
}

const storage = new MemoryStorage();
const CASE = process.env["CASE"] ?? "empty";

switch (CASE) {
  case "corrupt-terminal":
    storage.setItem("herdr-t3:settings:terminal", '{"fontSize": 20, "scrollba');
    break;
  case "wrong-type-general":
    storage.setItem("herdr-t3:settings:general", "[1,2,3]");
    break;
  case "legacy-fields":
    // Only fields an older version knew; unknown futureField must drop.
    storage.setItem(
      "herdr-t3:settings:terminal",
      JSON.stringify({ fontSize: 14, scrollbackLines: 2000, futureField: { x: 1 } }),
    );
    break;
  case "empty":
    break;
  default:
    throw new Error(`unknown CASE ${CASE}`);
}

(globalThis as { window?: unknown }).window = { localStorage: storage };

const settings = await import("./settings.ts");
console.log(
  JSON.stringify({
    terminal: settings.getTerminalSettings(),
    general: settings.getGeneralSettings(),
  }),
);

export {};
