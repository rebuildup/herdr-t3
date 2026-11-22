#!/usr/bin/env bun
/**
 * herdr-t3 UI lint — enforces the T3 Code primitive rules from
 * docs/internals/web-ui.md (see docs/design/rules.md for the mapping).
 *
 * Rules:
 *  R1 raw-control: styled raw <button>/<input>/<select>/<textarea> outside
 *     src/components/ui/ is an error. Semantic rows/tabs/handles are allowed
 *     only via an explicit `// ui-lint: allow <reason>` comment on the line.
 *  R2 title-attr: native `title=` is an error outside ui/ (Button maps it to
 *     Tooltip internally; elsewhere wrap in <Tooltip>). Same allow comment.
 *  R3 primitive-restyle: className on vendored primitives (Button, InlineButton,
 *     Dialog*, ContextMenu*, Select*, Input, Textarea, Label, Tooltip) may not
 *     contain visual restyle utilities (bg-, text- color, border, rounded,
 *     px-/py-/p-, h-/w-/size-, font-). Layout utilities are allowed.
 *  R4 theme-selector: `.dark`/`.light` class selectors in CSS are errors;
 *     use @variant dark/light. `style={{` with static values is an error.
 *
 * `bun scripts/lint-ui.ts --self-test` proves detection + exceptions.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SRC = join(ROOT, "src");
const UI_DIR = join(SRC, "components", "ui");
const ALLOW = /\/\/\s*ui-lint:\s*allow\b/;
const RESTYLE = /\b(?:bg-|text-(?:foreground|background|muted|accent|primary|secondary|destructive|error|success|warning|info|popover|card|sidebar|terminal|ghostty|[a-z]+-\d)|border(?:-|$)|rounded|p[xytblr]?-|(?:^|\s)font-)/;
const PRIMITIVES = /<(?:Button|InlineButton|Dialog|DialogContent|DialogTitle|DialogDescription|Select|SelectTrigger|SelectContent|SelectItem|SelectValue|Input|Textarea|Label|Tooltip|ContextMenu|ContextMenuTrigger|ContextMenuContent|ContextMenuItem)\b/g;

interface Violation { file: string; line: number; rule: string; message: string }

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(tsx?|css)$/.test(name)) yield p;
  }
}

function lintFile(path: string): Violation[] {
  const rel = relative(ROOT, path);
  const inUi = path.startsWith(UI_DIR);
  const text = readFileSync(path, "utf8");
  const out: Violation[] = [];
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    const n = i + 1;
    const allowed = ALLOW.test(line);
    if (!inUi && !allowed) {
      if (/<(button|input|select|textarea)\b/.test(line) && /className=/.test(line)) {
        out.push({ file: rel, line: n, rule: "R1", message: "styled raw control; use a ui/ primitive or add a ui-lint: allow comment" });
      }
      if (/\stitle=/.test(line)) {
        // Button/InlineButton intercept `title` and render a Tooltip; skip
        // title= attributes that belong to those elements (scan back for an
        // unclosed <Button/<InlineButton tag).
        let inButton = false;
        for (let j = i; j >= Math.max(0, i - 25); j--) {
          const l = lines[j]!;
          if (/<\/?(?:InlineButton|Button)\b/.test(l)) { inButton = true; break; }
          if (/\/>|<\/(?:InlineButton|Button)>/.test(l) && j !== i) break;
        }
        if (!inButton) out.push({ file: rel, line: n, rule: "R2", message: "native title= tooltip; use <Tooltip> or Button's title prop" });
      }
    }
    if (/\.(tsx?|jsx?)$/.test(path) && !inUi) {
      for (const m of line.matchAll(PRIMITIVES)) {
        const rest = line.slice(m.index);
        const cls = /className="([^"]*)"/.exec(rest)?.[1] ?? "";
        if (RESTYLE.test(cls)) {
          out.push({ file: rel, line: n, rule: "R3", message: `primitive restyle via className="${cls.slice(0, 60)}"; use variant/size props` });
        }
      }
    }
    if (path.endsWith(".css") && !line.includes("@custom-variant") && /(\.dark|\.light)\s*[{,]/.test(line)) {
      out.push({ file: rel, line: n, rule: "R4", message: "theme class selector; use @variant dark/light" });
    }
    if (!inUi && /style=\{\{/.test(line) && !/ui-lint: allow/.test(line)) {
      out.push({ file: rel, line: n, rule: "R4", message: "inline style; use a class/token or justify with ui-lint: allow" });
    }
  });
  return out;
}

function run(): Violation[] {
  const out: Violation[] = [];
  for (const f of walk(SRC)) out.push(...lintFile(f));
  return out;
}

const SELF_TEST = `
// fixture
<button className="px-2 py-1 rounded bg-primary">x</button>   // R1
<div title="tip">x</div>                                       // R2
<Button className="bg-red-500 text-white">x</Button>          // R3
`;

if (process.argv.includes("--self-test")) {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uilint-"));
  const f = path.join(dir, "fixture.tsx");
  fs.writeFileSync(f, SELF_TEST);
  const rel = lintFile(f).map((v) => v.rule);
  const ok = rel.includes("R1") && rel.includes("R2") && rel.includes("R3");
  // exception path: allow comment suppresses R1/R2 on that line
  fs.writeFileSync(f, '<button className="x" /> // ui-lint: allow semantic row\n<div title="t">x</div> // ui-lint: allow truncated label\n');
  const rel2 = lintFile(f);
  const ok2 = rel2.length === 0;
  console.log(`self-test: detect=${ok ? "PASS" : "FAIL"} exceptions=${ok2 ? "PASS" : "FAIL"}`);
  process.exit(ok && ok2 ? 0 : 1);
}

const violations = run();
for (const v of violations) console.log(`${v.file}:${v.line} [${v.rule}] ${v.message}`);
if (violations.length) {
  console.log(`\n${violations.length} UI lint violation(s)`);
  process.exit(1);
}
console.log("UI lint clean");
