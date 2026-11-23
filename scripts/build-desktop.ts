/**
 * Bundles desktop/main.ts to desktop/main.cjs (issue #90, M4 RC).
 *
 * Stamps the build commit into the bundle so packaged builds report a real
 * commit in Diagnostics/About instead of "unknown" — the packaged app is
 * launched without HERDR_T3_COMMIT in its environment.
 */
import { execFileSync } from "node:child_process";

let commit = "unknown";
try {
  commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
} catch {
  /* building outside a git checkout keeps "unknown" */
}

execFileSync(
  "bun",
  [
    "build",
    "desktop/main.ts",
    "--target",
    "node",
    "--format",
    "cjs",
    "--outfile",
    "desktop/main.cjs",
    "--external",
    "electron",
    "--define",
    `process.env.HERDR_T3_COMMIT=${JSON.stringify(commit)}`,
  ],
  { stdio: "inherit" },
);
console.log(`desktop/main.cjs built (commit ${commit})`);
