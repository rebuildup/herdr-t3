#!/usr/bin/env bun
/**
 * CSS portion of the herdr-t3 UI lint. JSX/TS rules live in .oxlintrc.json +
 * lint-plugin/ (see docs/design/rules.md for the T3 mapping).
 *
 *  C1 theme-selector: `.dark`/`.light` class selectors in CSS are errors;
 *     use `@variant dark` / `@variant light` (Tailwind v4).
 *
 * `bun scripts/lint-ui.ts --self-test` proves detection.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SRC = join(ROOT, "src");

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (name.endsWith(".css")) yield p;
  }
}

const violations: string[] = [];
for (const file of walk(SRC)) {
  const rel = relative(ROOT, file);
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((line, i) => {
      if (!line.includes("@custom-variant") && /(\.dark|\.light)\s*[{,]/.test(line)) {
        violations.push(`${rel}:${i + 1} [C1] theme class selector; use @variant dark/light`);
      }
    });
}

if (process.argv.includes("--self-test")) {
  const bad = ".dark { color: red; }\n.light, .foo { color: blue; }\n@custom-variant dark (&:where(.dark, .dark *));\n";
  const hits = bad.split("\n").filter((l) => /(\.dark|\.light)\s*[{,]/.test(l) && !l.includes("@custom-variant")).length;
  const ok = hits === 2;
  console.log(`self-test: ${ok ? "PASS" : "FAIL"}`);
  process.exit(ok ? 0 : 1);
}

for (const v of violations) console.log(v);
if (violations.length) {
  console.log(`\n${violations.length} UI lint violation(s)`);
  process.exit(1);
}
console.log("UI lint clean");
