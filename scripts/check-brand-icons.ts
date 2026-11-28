#!/usr/bin/env bun
/**
 * Brand icon pipeline check (issues #490/#517).
 *
 * Provenance chain this verifies:
 *   source of truth : build/icon.png (1024x1024 master render)
 *   macOS derivative: build/icon.icns (icns container, ic07-ic14 set)
 *   Windows derivative: build/icon.ico (PNG-compressed entries to 256px)
 *   distribution path: electron-builder.yml defaults — macOS packs
 *     build/icon.icns into the .app bundle, Windows packs build/icon.ico
 *     into the NSIS installer. No `icon:` override may point elsewhere
 *     without the file existing.
 *
 * The binaries are hoxay derivatives produced from the Rikyū master SVG
 * (docs/brand/originals/, PR #491) by scripts/generate-brand-icons.ts —
 * recolor/placement/scale only, master geometry untouched. Provenance is
 * bound by docs/brand/icon-manifest.json (source + output SHA-256),
 * verified below; originals are never redrawn.
 *
 * `bun scripts/check-brand-icons.ts --self-test` proves detection.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const BUILD = join(ROOT, "build");

const errors: string[] = [];
const fail = (msg: string) => errors.push(msg);

function pngSize(buf: Buffer): { w: number; h: number } | null {
  if (buf.length < 24) return null;
  if (buf.readUInt32BE(0) !== 0x89504e47 || buf.toString("latin1", 12, 16) !== "IHDR") return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

/** Returns the set of icns element types, or null when malformed. */
function icnsTypes(buf: Buffer): Set<string> | null {
  if (buf.length < 8 || buf.toString("latin1", 0, 4) !== "icns") return null;
  const types = new Set<string>();
  let off = 8;
  while (off + 8 <= buf.length) {
    const size = buf.readUInt32BE(off + 4);
    if (size < 8 || off + size > buf.length) return null;
    types.add(buf.toString("latin1", off, off + 4));
    off += size;
  }
  return off === buf.length ? types : null;
}

interface IcoEntry {
  w: number;
  h: number;
  size: number;
  offset: number;
  png: boolean;
}

function icoEntries(buf: Buffer): IcoEntry[] | null {
  if (buf.length < 6) return null;
  if (buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) return null;
  const count = buf.readUInt16LE(4);
  if (buf.length < 6 + count * 16) return null;
  const out: IcoEntry[] = [];
  for (let i = 0; i < count; i++) {
    const e = 6 + i * 16;
    const w = buf[e]! || 256;
    const h = buf[e + 1]! || 256;
    const size = buf.readUInt32LE(e + 8);
    const offset = buf.readUInt32LE(e + 12);
    if (offset + size > buf.length) return null;
    out.push({
      w,
      h,
      size,
      offset,
      png: buf.toString("latin1", offset, offset + 4) === "\x89PNG" ? true : buf[offset] === 0x89 && buf[offset + 1] === 0x50,
    });
  }
  return out;
}

function checkPng(rel: string, min: number) {
  const p = join(BUILD, rel);
  if (!existsSync(p)) return fail(`${rel}: missing`);
  const size = pngSize(readFileSync(p));
  if (!size) return fail(`${rel}: not a valid PNG`);
  if (size.w < min || size.h < min) fail(`${rel}: ${size.w}x${size.h} below ${min}px minimum`);
}

function checkIcns(rel: string) {
  const p = join(BUILD, rel);
  if (!existsSync(p)) return fail(`${rel}: missing`);
  const types = icnsTypes(readFileSync(p));
  if (!types) return fail(`${rel}: malformed icns container`);
  // electron-builder's documented macOS set: 16..1024 incl. @2x entries.
  for (const t of ["ic07", "ic08", "ic09", "ic10", "ic11", "ic12", "ic13", "ic14"]) {
    if (!types.has(t)) fail(`${rel}: missing icns element ${t}`);
  }
}

function checkIco(rel: string) {
  const p = join(BUILD, rel);
  if (!existsSync(p)) return fail(`${rel}: missing`);
  const entries = icoEntries(readFileSync(p));
  if (!entries || entries.length === 0) return fail(`${rel}: malformed ico`);
  const has256 = entries.some((e) => e.w >= 256 && e.h >= 256);
  if (!has256) fail(`${rel}: no 256x256 entry (Windows requires it for quality scaling)`);
  if (entries.some((e) => !e.png)) fail(`${rel}: contains non-PNG image data; prefer PNG-compressed entries`);
}

/** electron-builder picks build/icon.icns (mac) / build/icon.ico (win)
 *  by convention; an explicit `icon:` key must resolve to a real file. */
function checkBuilderConfig() {
  const p = join(ROOT, "electron-builder.yml");
  if (!existsSync(p)) return fail("electron-builder.yml: missing");
  const text = readFileSync(p, "utf8");
  for (const m of text.matchAll(/^\s*icon:\s*(\S+)\s*$/gm)) {
    const target = join(ROOT, m[1]!.replace(/^~\//, ""));
    if (!existsSync(target)) fail(`electron-builder.yml icon "${m[1]}" does not exist`);
  }
}

if (process.argv.includes("--self-test")) {
  const goodPng = Buffer.alloc(24);
  goodPng.writeUInt32BE(0x89504e47, 0);
  goodPng.write("IHDR", 12, "latin1");
  goodPng.writeUInt32BE(1024, 16);
  goodPng.writeUInt32BE(1024, 20);
  const badPng = Buffer.from("not a png at all");
  const okPng = pngSize(goodPng)?.w === 1024 && pngSize(badPng) === null;
  const icnsHead = Buffer.concat([Buffer.from("icns"), Buffer.alloc(4), Buffer.from("ic10"), Buffer.from([0, 0, 0, 16]), Buffer.alloc(8)]);
  const okIcns = icnsTypes(icnsHead)?.has("ic10") === true && icnsTypes(Buffer.from("nope")) === null;
  const icoHead = Buffer.alloc(22);
  icoHead.writeUInt16LE(1, 2);
  icoHead.writeUInt16LE(1, 4);
  icoHead.writeUInt8(0, 6); // 256 wide
  icoHead.writeUInt8(0, 7); // 256 high
  icoHead.writeUInt32LE(1, 14); // payload size
  icoHead.writeUInt32LE(22, 18); // payload offset
  const okIco = icoEntries(Buffer.concat([icoHead, Buffer.from([0x89, 0x50])]))?.[0]?.w === 256;
  const ok = okPng && okIcns && okIco;
  console.log(`self-test: ${ok ? "PASS" : "FAIL"}`);
  process.exit(ok ? 0 : 1);
}

/** Manifest provenance: master SVG hash + recorded output hashes must
 *  match the files actually shipped. .icns is presence/format-checked
 *  above (iconutil output is not byte-stable across versions). */
function checkManifest() {
  const mp = join(ROOT, "docs/brand/icon-manifest.json");
  if (!existsSync(mp)) return fail("docs/brand/icon-manifest.json: missing — run scripts/generate-brand-icons.ts");
  let m: { source?: { path?: string; sha256?: string }; outputs?: Record<string, string> };
  try {
    m = JSON.parse(readFileSync(mp, "utf8"));
  } catch {
    return fail("docs/brand/icon-manifest.json: invalid JSON");
  }
  const src = m.source?.path;
  if (!src || !existsSync(join(ROOT, src))) return fail(`manifest source ${src ?? "?"} missing`);
  const sha = createHash("sha256").update(readFileSync(join(ROOT, src))).digest("hex");
  if (m.source?.sha256 !== sha) {
    fail(`master SVG drift: manifest=${m.source?.sha256} actual=${sha} — regenerate icons`);
  }
  for (const [rel, hash] of Object.entries(m.outputs ?? {})) {
    if (rel.endsWith(".icns")) continue;
    const p = join(ROOT, rel);
    if (!existsSync(p)) { fail(`${rel}: missing`); continue; }
    const actual = createHash("sha256").update(readFileSync(p)).digest("hex");
    if (actual !== hash) fail(`${rel}: output hash mismatch — regenerate icons`);
  }
}

checkPng("icon.png", 512);
checkIcns("icon.icns");
checkIco("icon.ico");
checkBuilderConfig();
checkManifest();

for (const e of errors) console.log(`FAIL ${e}`);
if (errors.length) {
  console.log(`\n${errors.length} brand icon violation(s)`);
  process.exit(1);
}
console.log("ok      brand icons valid (png master + icns + ico + builder config)");
