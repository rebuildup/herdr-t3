/**
 * DOM KeyboardEvent → the EngineKey libghostty's key encoder takes. The names are the module's own
 * GhosttyKey values (ghostty_type_json, dumped once for this map); a name the running module does not
 * know is refused by the caller through GhosttySession.hasKey, and the key falls back to its text.
 */
import type { EngineKey, EngineMods } from "../../../shared/ghostty/engine.ts";

/** event.code → GhosttyKey name, for the keys a terminal reports by position rather than by character */
const CODE_KEYS: Record<string, string> = {
  Backquote: "BACKQUOTE", Backslash: "BACKSLASH", BracketLeft: "BRACKET_LEFT", BracketRight: "BRACKET_RIGHT",
  Comma: "COMMA", Equal: "EQUAL", IntlBackslash: "INTL_BACKSLASH", IntlRo: "INTL_RO", IntlYen: "INTL_YEN",
  Minus: "MINUS", Period: "PERIOD", Quote: "QUOTE", Semicolon: "SEMICOLON", Slash: "SLASH",
  Space: "SPACE", Tab: "TAB", Enter: "ENTER", NumpadEnter: "NUMPAD_ENTER", Escape: "ESCAPE",
  Backspace: "BACKSPACE", Delete: "DELETE", Insert: "INSERT", Home: "HOME", End: "END",
  PageUp: "PAGE_UP", PageDown: "PAGE_DOWN",
  ArrowUp: "ARROW_UP", ArrowDown: "ARROW_DOWN", ArrowLeft: "ARROW_LEFT", ArrowRight: "ARROW_RIGHT",
  CapsLock: "CAPS_LOCK", NumLock: "NUM_LOCK", ScrollLock: "SCROLL_LOCK", Pause: "PAUSE", PrintScreen: "PRINT_SCREEN",
  ContextMenu: "CONTEXT_MENU", Convert: "CONVERT", NonConvert: "NON_CONVERT", KanaMode: "KANA_MODE",
  ShiftLeft: "SHIFT_LEFT", ShiftRight: "SHIFT_RIGHT",
  ControlLeft: "CONTROL_LEFT", ControlRight: "CONTROL_RIGHT",
  AltLeft: "ALT_LEFT", AltRight: "ALT_RIGHT",
  MetaLeft: "META_LEFT", MetaRight: "META_RIGHT",
};

const NUMPAD_CODES: Record<string, string> = {
  Numpad0: "NUMPAD_0", Numpad1: "NUMPAD_1", Numpad2: "NUMPAD_2", Numpad3: "NUMPAD_3", Numpad4: "NUMPAD_4",
  Numpad5: "NUMPAD_5", Numpad6: "NUMPAD_6", Numpad7: "NUMPAD_7", Numpad8: "NUMPAD_8", Numpad9: "NUMPAD_9",
  NumpadAdd: "NUMPAD_ADD", NumpadSubtract: "NUMPAD_SUBTRACT", NumpadMultiply: "NUMPAD_MULTIPLY",
  NumpadDivide: "NUMPAD_DIVIDE", NumpadDecimal: "NUMPAD_DECIMAL", NumpadComma: "NUMPAD_COMMA",
  NumpadEqual: "NUMPAD_EQUAL", NumpadBackspace: "NUMPAD_BACKSPACE", NumpadClear: "NUMPAD_CLEAR",
  NumpadClearEntry: "NUMPAD_CLEAR_ENTRY", NumpadMemoryAdd: "NUMPAD_MEMORY_ADD",
  NumpadMemorySubtract: "NUMPAD_MEMORY_SUBTRACT", NumpadMemoryClear: "NUMPAD_MEMORY_CLEAR",
  NumpadMemoryRecall: "NUMPAD_MEMORY_RECALL", NumpadMemoryStore: "NUMPAD_MEMORY_STORE",
  NumpadUp: "NUMPAD_UP", NumpadDown: "NUMPAD_DOWN", NumpadLeft: "NUMPAD_LEFT", NumpadRight: "NUMPAD_RIGHT",
  NumpadHome: "NUMPAD_HOME", NumpadEnd: "NUMPAD_END", NumpadPageUp: "NUMPAD_PAGE_UP",
  NumpadPageDown: "NUMPAD_PAGE_DOWN", NumpadInsert: "NUMPAD_INSERT", NumpadDelete: "NUMPAD_DELETE",
  NumpadBegin: "NUMPAD_BEGIN",
};

function codeName(code: string): string | null {
  const named = CODE_KEYS[code] ?? NUMPAD_CODES[code];
  if (named) return named;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return `DIGIT_${code.slice(5)}`;
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  return null;
}

/** the character a key writes without shift, for the chords the encoder tells apart (ctrl+shift+a vs ctrl+a) */
function unshiftedOf(code: string): string | undefined {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  return undefined;
}

function modsOf(event: KeyboardEvent): EngineMods {
  const mods: EngineMods = {};
  if (event.shiftKey) mods.shift = true;
  if (event.ctrlKey) mods.ctrl = true;
  if (event.altKey) mods.alt = true;
  if (event.metaKey) mods.super = true;
  return mods;
}

/**
 * The EngineKey a DOM key event names, or null when the event is not a key the terminal should see
 * (a held modifier alone reports through the encoder as nothing anyway, but the surface drops it
 * earlier). `text` is what the key wrote with shift applied; `unshifted` what it writes without.
 */
export function engineKeyFor(event: KeyboardEvent, action: "press" | "repeat" | "release"): EngineKey | null {
  const name = codeName(event.code);
  if (!name) return null;
  const text = event.key.length === 1 ? event.key : undefined;
  const key: EngineKey = { key: name, mods: modsOf(event), action };
  if (text !== undefined) key.text = text;
  const unshifted = unshiftedOf(event.code);
  if (unshifted !== undefined) key.unshifted = unshifted;
  return key;
}
