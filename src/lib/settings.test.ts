import { describe, expect, test } from "bun:test";

/*
 * Settings store contract (issue #85): one localStorage key per section,
 * validated on load, clamped on write, change-notifying. The fake Storage is
 * installed before settings.ts evaluates so its persisted state is exercised
 * exactly like a fresh app start.
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
(globalThis as { window?: unknown }).window = { localStorage: storage };

const settings = await import("./settings.ts");

describe("terminal settings", () => {
  test("defaults apply when storage is empty", () => {
    expect(settings.getTerminalSettings()).toEqual(settings.TERMINAL_DEFAULTS);
  });

  test("set merges, clamps and persists under one key", () => {
    let notified = 0;
    const off = settings.onTerminalSettingsChange(() => notified++);
    settings.setTerminalSettings({ fontSize: 99, scrollbackLines: 50, fontFamily: "Berkeley Mono" });
    const current = settings.getTerminalSettings();
    expect(current.fontSize).toBe(32);
    expect(current.scrollbackLines).toBe(100);
    expect(current.fontFamily).toBe("Berkeley Mono");
    expect(current.lineHeight).toBeNull();
    expect(notified).toBe(1);
    off();

    const raw = storage.getItem("herdr-t3:settings:terminal");
    expect(raw).not.toBeNull();
    // Restart path: the stored JSON must parse back to the live settings.
    expect(settings.parseTerminalSettings(JSON.parse(raw!))).toEqual(current);
  });

  test("lineHeight accepts null and numeric multipliers", () => {
    settings.setTerminalSettings({ lineHeight: 1.3 });
    expect(settings.getTerminalSettings().lineHeight).toBe(1.3);
    settings.setTerminalSettings({ lineHeight: null });
    expect(settings.getTerminalSettings().lineHeight).toBeNull();
  });
});

describe("general settings", () => {
  test("round-trips through its own key", () => {
    settings.setGeneralSettings({ confirmCloseWorkspace: true });
    expect(settings.getGeneralSettings().confirmCloseWorkspace).toBe(true);
    const raw = storage.getItem("herdr-t3:settings:general");
    expect(settings.parseGeneralSettings(JSON.parse(raw!))).toEqual(
      settings.getGeneralSettings(),
    );
    settings.setGeneralSettings({ confirmCloseWorkspace: false });
  });
});
