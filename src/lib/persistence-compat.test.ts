import { execFileSync } from "node:child_process";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

/*
 * Persistence compatibility contract tests (issue #239,
 * docs/migration/persistence-compatibility.md). Isolated MemoryStorage
 * only — never a real profile. The load() path runs in a fresh bun
 * process via persistence-compat.boot.ts because bun test shares the
 * module registry across files in one process.
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
const BOOT = join(import.meta.dir, "persistence-compat.boot.ts");

function boot(caseName: string): { terminal: unknown; general: unknown } {
  const out = execFileSync(process.execPath, [BOOT], {
    env: { ...process.env, CASE: caseName },
    encoding: "utf8",
  });
  return JSON.parse(out) as { terminal: unknown; general: unknown };
}

const settings = await import("./settings.ts");

// bun test shares one process/module registry across files, so
// window.localStorage may belong to another file's fixture. Swap it
// explicitly for tests that exercise the write path and restore after.
function installStorage(next: Storage | null): () => void {
  const g = globalThis as { window?: { localStorage?: Storage } };
  const w = (g.window ??= {});
  const prev = w.localStorage ?? null;
  if (next === null) delete w.localStorage;
  else w.localStorage = next;
  return () => {
    if (prev === null) delete w.localStorage;
    else w.localStorage = prev;
  };
}

describe("fresh-start load against seeded storage", () => {
  test("empty storage → defaults", () => {
    const loaded = boot("empty");
    expect(loaded.terminal).toEqual(settings.TERMINAL_DEFAULTS);
    expect(loaded.general).toEqual(settings.GENERAL_DEFAULTS);
  });

  test("truncated JSON → terminal defaults", () => {
    const loaded = boot("corrupt-terminal");
    expect(loaded.terminal).toEqual(settings.TERMINAL_DEFAULTS);
  });

  test("wrong-type JSON → general defaults", () => {
    const loaded = boot("wrong-type-general");
    expect(loaded.general).toEqual(settings.GENERAL_DEFAULTS);
  });

  test("legacy payload: known fields kept, unknown field dropped on load", () => {
    const loaded = boot("legacy-fields");
    expect(loaded.terminal).toEqual({
      fontFamily: settings.TERMINAL_DEFAULTS.fontFamily,
      fontSize: 14,
      lineHeight: null,
      scrollbackLines: 2000,
    });
  });
});

describe("round-trip and old→new→old semantics", () => {
  test("write → stored JSON → parse → identical settings", () => {
    const restore = installStorage(storage);
    try {
      settings.setTerminalSettings({ fontSize: 15, scrollbackLines: 5000 });
      const raw = storage.getItem("herdr-t3:settings:terminal");
      expect(raw).not.toBeNull();
      expect(settings.parseTerminalSettings(JSON.parse(raw!))).toEqual(
        settings.getTerminalSettings(),
      );
    } finally {
      restore();
    }
  });

  test("payload with only older-known fields round-trips unchanged", () => {
    // Simulates a build that only knew fontSize/scrollbackLines.
    const legacy = { fontSize: 14, scrollbackLines: 2000 };
    const parsed = settings.parseTerminalSettings(legacy);
    expect(parsed.fontFamily).toBe(settings.TERMINAL_DEFAULTS.fontFamily);
    expect(parsed.lineHeight).toBeNull();
    expect(parsed.fontSize).toBe(14);
    expect(parsed.scrollbackLines).toBe(2000);
    // Re-serializing and re-parsing is stable (old→new→old).
    expect(settings.parseTerminalSettings(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  test("unknown fields are dropped on rewrite (recorded forward-compat rule)", () => {
    const withFuture = { fontSize: 16, futureField: { nested: true } };
    const parsed = settings.parseTerminalSettings(withFuture);
    expect("futureField" in parsed).toBe(false);
    const rewritten = JSON.parse(JSON.stringify(parsed)) as Record<string, unknown>;
    expect("futureField" in rewritten).toBe(false);
  });
});

describe("fault injection on values", () => {
  test("non-object payloads → defaults", () => {
    // load() rejects non-object JSON before parse; parse itself is only
    // reached with objects/arrays. null is excluded — it never reaches
    // parse (load returns defaults first).
    for (const bad of [[], "x", 42, true]) {
      const payload = bad as unknown as Record<string, unknown>;
      expect(settings.parseTerminalSettings(payload)).toEqual(settings.TERMINAL_DEFAULTS);
      expect(settings.parseGeneralSettings(payload)).toEqual(settings.GENERAL_DEFAULTS);
    }
  });

  test("out-of-range and wrong-typed fields → clamped/defaulted per field", () => {
    const parsed = settings.parseTerminalSettings({
      fontSize: 999,
      scrollbackLines: -5,
      fontFamily: 42,
      lineHeight: "tall",
    });
    expect(parsed.fontSize).toBe(32);
    expect(parsed.scrollbackLines).toBe(100);
    expect(parsed.fontFamily).toBe(settings.TERMINAL_DEFAULTS.fontFamily);
    // Wrong-typed lineHeight resolves to the numeric fallback (1.2),
    // not null — recorded current behavior per the compat contract.
    expect(parsed.lineHeight).toBe(1.2);
  });

  test("null/undefined fields fall back per field, not wholesale", () => {
    const parsed = settings.parseTerminalSettings({ fontSize: null, scrollbackLines: 8000 });
    expect(parsed.fontSize).toBe(settings.TERMINAL_DEFAULTS.fontSize);
    expect(parsed.scrollbackLines).toBe(8000);
  });
});

describe("storage failure", () => {
  test("setItem throwing → settings still update in memory, no throw", () => {
    const throwing = {
      get length() {
        return 0;
      },
      clear() {},
      getItem() {
        return null;
      },
      key() {
        return null;
      },
      removeItem() {},
      setItem() {
        throw new Error("QuotaExceededError");
      },
    } as Storage;
    const restore = installStorage(throwing);
    try {
      expect(() => settings.setGeneralSettings({ confirmCloseWorkspace: true })).not.toThrow();
      expect(settings.getGeneralSettings().confirmCloseWorkspace).toBe(true);
    } finally {
      restore();
    }
  });
});
