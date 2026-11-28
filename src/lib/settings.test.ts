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

  test("copyOnSelect defaults off, rejects non-booleans and round-trips (issue #440)", () => {
    // profiles written before the key existed, or with a corrupt value,
    // must parse back to the OFF default — never a truthy accident
    expect(settings.parseTerminalSettings({}).copyOnSelect).toBe(false);
    expect(settings.parseTerminalSettings({ copyOnSelect: "yes" }).copyOnSelect).toBe(false);
    expect(settings.parseTerminalSettings({ copyOnSelect: 1 }).copyOnSelect).toBe(false);
    expect(settings.TERMINAL_DEFAULTS.copyOnSelect).toBe(false);

    settings.setTerminalSettings({ copyOnSelect: true });
    expect(settings.getTerminalSettings().copyOnSelect).toBe(true);
    const raw = storage.getItem("herdr-t3:settings:terminal");
    expect(settings.parseTerminalSettings(JSON.parse(raw!)).copyOnSelect).toBe(true);
    settings.setTerminalSettings({ copyOnSelect: false });
    expect(settings.getTerminalSettings().copyOnSelect).toBe(false);
  });

  test("copy range patterns default empty, accept bounded strings and round-trip (issue #429)", () => {
    expect(settings.parseTerminalSettings({}).copyStartPattern).toBe("");
    expect(settings.parseTerminalSettings({}).copyEndPattern).toBe("");
    // wrong-typed values fall back to empty — never a stored non-string
    expect(settings.parseTerminalSettings({ copyStartPattern: 42 }).copyStartPattern).toBe("");
    expect(settings.parseTerminalSettings({ copyEndPattern: null }).copyEndPattern).toBe("");
    // over-long patterns are truncated at the 200-char bound
    const long = "x".repeat(500);
    expect(settings.parseTerminalSettings({ copyStartPattern: long }).copyStartPattern).toHaveLength(200);

    settings.setTerminalSettings({ copyStartPattern: "^## Report", copyEndPattern: "^Done\\.$" });
    const current = settings.getTerminalSettings();
    expect(current.copyStartPattern).toBe("^## Report");
    expect(current.copyEndPattern).toBe("^Done\\.$");
    const raw = storage.getItem("herdr-t3:settings:terminal");
    expect(settings.parseTerminalSettings(JSON.parse(raw!))).toEqual(current);
    settings.setTerminalSettings({ copyStartPattern: "", copyEndPattern: "" });
  });
});

describe("notifications settings", () => {
  test("defaults to top-right and round-trips through its own key", () => {
    expect(settings.getNotificationsSettings()).toEqual(settings.NOTIFICATIONS_DEFAULTS);
    expect(settings.NOTIFICATIONS_DEFAULTS.position).toBe("top-right");
    settings.setNotificationsSettings({ position: "bottom-left" });
    expect(settings.getNotificationsSettings().position).toBe("bottom-left");
    const raw = storage.getItem("herdr-t3:settings:notifications");
    expect(raw).not.toBeNull();
    expect(settings.parseNotificationsSettings(JSON.parse(raw!))).toEqual(
      settings.getNotificationsSettings(),
    );
    settings.setNotificationsSettings({ position: "top-right" });
  });

  test("invalid persisted values fall back to the default", () => {
    expect(settings.parseNotificationsSettings({ position: "middle" }).position).toBe(
      "top-right",
    );
    expect(settings.parseNotificationsSettings({}).position).toBe("top-right");
    expect(settings.parseNotificationsSettings({ position: 42 }).position).toBe(
      "top-right",
    );
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
