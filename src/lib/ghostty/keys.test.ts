import { describe, expect, it } from "bun:test";
import { engineKeyFor } from "./keys.ts";

const event = (code: string, key: string, mods: Partial<KeyboardEvent> = {}): KeyboardEvent =>
  ({ code, key, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...mods }) as KeyboardEvent;

describe("ghostty keys: DOM events to EngineKey", () => {
  it("maps letters, digits and named keys to the module's GhosttyKey names", () => {
    expect(engineKeyFor(event("KeyA", "a"), "press")).toMatchObject({ key: "A", text: "a", unshifted: "a" });
    expect(engineKeyFor(event("KeyZ", "Z", { shiftKey: true }), "press")).toMatchObject({ key: "Z", text: "Z", unshifted: "z" });
    expect(engineKeyFor(event("Digit1", "!", { shiftKey: true }), "press")).toMatchObject({ key: "DIGIT_1", text: "!", unshifted: "1" });
    expect(engineKeyFor(event("Enter", "Enter"), "press")?.key).toBe("ENTER");
    expect(engineKeyFor(event("NumpadEnter", "Enter"), "press")?.key).toBe("NUMPAD_ENTER");
    expect(engineKeyFor(event("ArrowUp", "ArrowUp"), "press")?.key).toBe("ARROW_UP");
    expect(engineKeyFor(event("F5", "F5"), "press")?.key).toBe("F5");
    expect(engineKeyFor(event("F13", "F13"), "press")?.key).toBe("F13");
    expect(engineKeyFor(event("BracketLeft", "["), "press")?.key).toBe("BRACKET_LEFT");
    expect(engineKeyFor(event("IntlBackslash", "§"), "press")?.key).toBe("INTL_BACKSLASH");
    expect(engineKeyFor(event("NumpadAdd", "+"), "press")?.key).toBe("NUMPAD_ADD");
  });

  it("carries modifiers and the action", () => {
    const key = engineKeyFor(event("KeyC", "c", { ctrlKey: true, shiftKey: true }), "repeat");
    expect(key).toMatchObject({ key: "C", action: "repeat", mods: { ctrl: true, shift: true } });
    const released = engineKeyFor(event("ArrowLeft", "ArrowLeft"), "release");
    expect(released?.action).toBe("release");
  });

  it("refuses codes that name no GhosttyKey", () => {
    expect(engineKeyFor(event("Unidentified", ""), "press")).toBeNull();
    expect(engineKeyFor(event("F25", "F25"), "press")).toBeNull();
    expect(engineKeyFor(event("AudioVolumeUp", "AudioVolumeUp"), "press")).toBeNull();
  });
});
