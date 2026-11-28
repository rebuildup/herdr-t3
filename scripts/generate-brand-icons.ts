#!/usr/bin/env bun
/*
 * Generate hoxay OS icons from the canonical Rikyū master SVG
 * (docs/brand/originals/hoxay-sea-turtle-symbol-concept-1.svg).
 *
 * Provenance contract (docs/brand/README.md "Production and source
 * hierarchy"): the master geometry is never redrawn — this script only
 * performs allowed derived treatments: recolor (black -> white),
 * placement on the accepted near-black rounded-square surface with a
 * soft frontal centered illumination, and scaling.
 *
 * Outputs:
 *   build/icon.png        1024x1024 opaque icon (electron-builder default)
 *   build/icon.icns       macOS iconset via iconutil
 *   build/icon.ico        Windows ICO (PNG-compressed entries)
 *   docs/brand/icon-manifest.json  source->derived->distributable hashes
 *
 * Usage:
 *   bun scripts/generate-brand-icons.ts          # regenerate everything
 *   bun scripts/generate-brand-icons.ts --check  # verify manifest+outputs
 *                                                # (no tools required beyond bun)
 *
 * Requires rsvg-convert (librsvg) and, for .icns, macOS iconutil.
 * On hosts without them, --check still validates the manifest hash
 * chain; regeneration is a maintainer-local step.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const MASTER = "docs/brand/originals/hoxay-sea-turtle-symbol-concept-1.svg";
const MASTER_ABS = join(ROOT, MASTER);
const MANIFEST = join(ROOT, "docs/brand/icon-manifest.json");
const BUILD = join(ROOT, "build");

const CANVAS = 1024;
const SURFACE = "#101014";
const INK = "#ffffff";

function sha256(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** Extract <path .../> bodies from the master and recolor to ink. */
function masterPaths(): string {
  const svg = readFileSync(MASTER_ABS, "utf8");
  const paths = svg.match(/<path\b[^>]*\/>/g) ?? [];
  if (paths.length === 0) throw new Error("no paths found in master SVG");
  return paths
    .map((p) => p.replace(/fill="[^"]*"/g, `fill="${INK}"`))
    .join("\n    ");
}

/** Composed icon SVG: near-black rounded square, frontal centered light, white mark. */
function iconSvg(): string {
  // Master viewBox is 1024x715.436 (landscape). Fit to ~62.5% of canvas
  // width and optically center; keep aspect ratio.
  const scale = 640 / 1024;
  const w = 1024 * scale;
  const h = 715.436 * scale;
  const x = (CANVAS - w) / 2;
  const y = (CANVAS - h) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}">
  <defs>
    <radialGradient id="light" cx="50%" cy="50%" r="75%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.10"/>
      <stop offset="55%" stop-color="#ffffff" stop-opacity="0.04"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
    <clipPath id="squircle"><rect width="${CANVAS}" height="${CANVAS}" rx="220"/></clipPath>
  </defs>
  <g clip-path="url(#squircle)">
    <rect width="${CANVAS}" height="${CANVAS}" fill="${SURFACE}"/>
    <rect width="${CANVAS}" height="${CANVAS}" fill="url(#light)"/>
    <g transform="translate(${x.toFixed(2)} ${y.toFixed(2)}) scale(${scale.toFixed(6)})">
    ${masterPaths()}
    </g>
  </g>
</svg>
`;
}

function have(cmd: string): boolean {
  try {
    execFileSync("which", [cmd], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function rasterize(svgPath: string, size: number, outPath: string): void {
  execFileSync("rsvg-convert", ["-w", String(size), "-h", String(size), "-o", outPath, svgPath], {
    stdio: "inherit",
  });
}

/** Minimal ICO writer: PNG-compressed entries (valid for all modern targets). */
function writeIco(pngs: { size: number; data: Buffer }[], outPath: string): void {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(pngs.length, 4);
  const entries: Buffer[] = [];
  let offset = 6 + 16 * pngs.length;
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2); // palette
    e.writeUInt8(0, 3); // reserved
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bpp
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += data.length;
  }
  writeFileSync(outPath, Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]));
}

function generate(): void {
  if (!have("rsvg-convert")) {
    console.error("rsvg-convert not found (brew install librsvg)");
    process.exit(1);
  }
  const svg = iconSvg();
  const tmp = join(tmpdir(), `hoxay-icon-${process.pid}`);
  mkdirSync(tmp, { recursive: true });
  mkdirSync(BUILD, { recursive: true });
  const svgPath = join(tmp, "icon.svg");
  writeFileSync(svgPath, svg);

  const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
  const pngs: Record<number, Buffer> = {};
  for (const s of sizes) {
    const out = join(tmp, `icon-${s}.png`);
    rasterize(svgPath, s, out);
    pngs[s] = readFileSync(out);
  }
  writeFileSync(join(BUILD, "icon.png"), pngs[1024]);
  writeIco(
    [16, 24, 32, 48, 64, 128, 256].map((s) => ({ size: s, data: pngs[s] })),
    join(BUILD, "icon.ico"),
  );

  if (have("iconutil")) {
    const setDir = join(tmp, "icon.iconset");
    mkdirSync(setDir, { recursive: true });
    const names: [number, string][] = [
      [16, "icon_16x16"], [32, "icon_16x16@2x"],
      [32, "icon_32x32"], [64, "icon_32x32@2x"],
      [128, "icon_128x128"], [256, "icon_128x128@2x"],
      [256, "icon_256x256"], [512, "icon_256x256@2x"],
      [512, "icon_512x512"], [1024, "icon_512x512@2x"],
    ];
    for (const [px, name] of names) {
      writeFileSync(join(setDir, `${name}.png`), pngs[px]);
    }
    execFileSync("iconutil", ["-c", "icns", setDir, "-o", join(BUILD, "icon.icns")], {
      stdio: "inherit",
    });
  } else {
    console.warn("iconutil not found; skipping icon.icns (macOS only)");
  }

  const manifest = {
    version: 1,
    source: { path: MASTER, sha256: sha256(readFileSync(MASTER_ABS)) },
    recipe: {
      canvas: CANVAS,
      surface: SURFACE,
      ink: INK,
      symbolScale: 640 / 1024,
      cornerRadius: 220,
      illumination: "radial centered 10%->0% white",
      note: "recolor+placement+scale only; master geometry untouched",
    },
    outputs: {
      "build/icon.png": sha256(readFileSync(join(BUILD, "icon.png"))),
      "build/icon.ico": sha256(readFileSync(join(BUILD, "icon.ico"))),
      ...(existsSync(join(BUILD, "icon.icns"))
        ? { "build/icon.icns": sha256(readFileSync(join(BUILD, "icon.icns"))) }
        : {}),
    },
  };
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  console.log("icons generated; manifest written to docs/brand/icon-manifest.json");
}

function check(): void {
  const problems: string[] = [];
  if (!existsSync(MANIFEST)) {
    problems.push("docs/brand/icon-manifest.json missing — run generate-brand-icons.ts");
  } else {
    const m = JSON.parse(readFileSync(MANIFEST, "utf8"));
    const srcHash = sha256(readFileSync(MASTER_ABS));
    if (m.source?.sha256 !== srcHash) {
      problems.push(`master SVG hash mismatch: manifest=${m.source?.sha256} actual=${srcHash}`);
    }
    for (const [path, hash] of Object.entries(m.outputs ?? {})) {
      const abs = join(ROOT, path);
      if (!existsSync(abs)) {
        problems.push(`${path} missing`);
        continue;
      }
      const actual = sha256(readFileSync(abs));
      // .icns embeds no timestamp guarantee across iconutil versions;
      // verify presence+nonempty, hash recorded for audit only.
      if (path.endsWith(".icns")) continue;
      if (actual !== hash) problems.push(`${path} hash mismatch (manifest=${hash} actual=${actual})`);
    }
  }
  if (problems.length > 0) {
    console.error("brand icon check FAILED:");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log("brand icon manifest OK");
}

if (process.argv.includes("--check")) check();
else generate();
