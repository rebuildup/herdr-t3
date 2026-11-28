import { describe, expect, it } from "bun:test";
import { sanitizePasteText } from "./pasteText.ts";

describe("sanitizePasteText (issue #434)", () => {
  it("replaces ESC so a wrapped body cannot terminate the bracket early", () => {
    expect(sanitizePasteText("a\x1b[201~b")).toBe("a [201~b");
    expect(sanitizePasteText("x\x1by")).toBe("x y");
  });
  it("preserves newlines, tabs, CR and BEL", () => {
    expect(sanitizePasteText("one\ntwo\tthree\rfour\x07")).toBe("one\ntwo\tthree\rfour\x07");
  });
  it("preserves CRLF pairs, multibyte text and a trailing newline", () => {
    expect(sanitizePasteText("a\r\nb\r\n")).toBe("a\r\nb\r\n");
    expect(sanitizePasteText("日本語テスト 🐚\n")).toBe("日本語テスト 🐚\n");
  });
  it("leaves plain text untouched", () => {
    expect(sanitizePasteText("hello world")).toBe("hello world");
    expect(sanitizePasteText("")).toBe("");
  });
});
