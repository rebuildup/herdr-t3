#!/usr/bin/env bun
/**
 * Validates docs/migration/capabilities.json — the capability registry
 * for the GPUI migration program (issue #235, ADR-0013).
 *
 * Enforced invariants:
 *  - schema_version is supported
 *  - capability and contract ids are unique
 *  - stage is a known enum value
 *  - contract references resolve to a declared contract at the pinned version
 *  - stages at or beyond "current-verified" require at least one scenario
 *    or evidence reference (no evidence-less completion)
 *  - implemented=false capabilities cannot claim a verified stage
 *  - excluded capabilities are always stage "not-started"
 *  - referenced repo paths (spec/scenarios/evidence/parity/spec_ref)
 *    exist; issue:/pr:/url:/note: prefixed refs are exempt
 *  - os/boundary/owner fields use known vocabularies
 *
 * Usage: bun scripts/check-migration-registry.ts [--self-test]
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const REGISTRY_PATH = join(REPO_ROOT, "docs/migration/capabilities.json");

const STAGES = [
  "not-started",
  "contract-defined",
  "current-verified",
  "rust-implemented",
  "equivalence-verified",
  "switched",
  "removed",
] as const;
type Stage = (typeof STAGES)[number];

const VERIFIED_INDEX = STAGES.indexOf("current-verified");
const BOUNDARIES = new Set(["B1", "B2", "B3", "B4", "B5", "B6", "B7", "B8"]);
const PLATFORMS = new Set(["macos", "windows-11"]);
const EXEMPT_REF = /^(issue|pr|url|note|manual):/;
const ISSUE_REF = /^issue:\d+$/;
const PR_REF = /^pr:\d+$/;

interface Contract {
  id: string;
  version: number;
  title: string;
  spec: string;
  oracle: string;
}

interface Capability {
  id: string;
  title: string;
  area: string;
  owner: string;
  boundary: string;
  contracts?: string[];
  os: string[];
  operations: string[];
  errors?: string[];
  side_effects?: string[];
  scenarios?: string[];
  evidence?: string[];
  spec_ref?: string;
  stage: Stage;
  status: {
    implemented: boolean;
    known_issues?: number[];
    os_gaps?: string[];
    upstream_deps?: string[];
    excluded?: boolean;
  };
  parity?: string;
}

interface Registry {
  schema_version: number;
  contracts: Contract[];
  capabilities: Capability[];
}

const errors: string[] = [];

function fail(msg: string): void {
  errors.push(msg);
}

function checkRef(where: string, ref: string): void {
  if (EXEMPT_REF.test(ref)) {
    if (ref.startsWith("issue:") && !ISSUE_REF.test(ref)) {
      fail(`${where}: malformed issue ref "${ref}"`);
    }
    if (ref.startsWith("pr:") && !PR_REF.test(ref)) {
      fail(`${where}: malformed pr ref "${ref}"`);
    }
    return;
  }
  const path = ref.split("#")[0];
  if (!existsSync(join(REPO_ROOT, path))) {
    fail(`${where}: referenced path does not exist: ${ref}`);
  }
}

function validate(reg: Registry): void {
  if (reg.schema_version !== 1) {
    fail(`unsupported schema_version: ${reg.schema_version}`);
  }

  const contractIds = new Set<string>();
  for (const c of reg.contracts ?? []) {
    if (!c.id || typeof c.version !== "number") {
      fail(`contract missing id/version: ${JSON.stringify(c)}`);
      continue;
    }
    const key = `${c.id}@${c.version}`;
    if (contractIds.has(key)) fail(`duplicate contract ref key: ${key}`);
    contractIds.add(key);
    if (!c.spec) fail(`contract ${key}: missing spec`);
    else checkRef(`contract ${key}`, c.spec);
  }

  const capIds = new Set<string>();
  for (const cap of reg.capabilities ?? []) {
    const where = `capability ${cap.id ?? "<missing id>"}`;
    if (!cap.id) {
      fail("capability missing id");
      continue;
    }
    if (capIds.has(cap.id)) fail(`duplicate capability id: ${cap.id}`);
    capIds.add(cap.id);

    if (!STAGES.includes(cap.stage)) {
      fail(`${where}: unknown stage "${cap.stage}"`);
    }
    if (!BOUNDARIES.has(cap.boundary)) {
      fail(`${where}: unknown boundary "${cap.boundary}"`);
    }
    for (const os of cap.os ?? []) {
      if (!PLATFORMS.has(os)) fail(`${where}: unknown platform "${os}"`);
    }
    if (!cap.owner) fail(`${where}: missing owner`);
    if (!Array.isArray(cap.operations)) {
      fail(`${where}: operations must be a list`);
    } else if (cap.operations.length === 0 && cap.status?.implemented !== false) {
      fail(`${where}: operations must be a non-empty list for implemented capabilities`);
    }

    for (const ref of cap.contracts ?? []) {
      const at = ref.lastIndexOf("@");
      const id = at === -1 ? ref : ref.slice(0, at);
      const ver = at === -1 ? undefined : Number(ref.slice(at + 1));
      const resolved = reg.contracts?.find(
        (c) => c.id === id && (ver === undefined || c.version === ver),
      );
      if (!resolved) {
        fail(`${where}: unresolved contract ref "${ref}"`);
      }
    }

    const stageIdx = STAGES.indexOf(cap.stage);
    const refs = [...(cap.scenarios ?? []), ...(cap.evidence ?? [])];
    if (stageIdx >= VERIFIED_INDEX && refs.length === 0) {
      fail(`${where}: stage "${cap.stage}" requires scenario/evidence refs`);
    }
    if (cap.status?.implemented === false) {
      if (stageIdx >= VERIFIED_INDEX) {
        fail(`${where}: unimplemented capability cannot be stage "${cap.stage}"`);
      }
    }
    if (cap.status?.excluded === true && cap.stage !== "not-started") {
      fail(`${where}: excluded capability must stay stage "not-started"`);
    }

    for (const ref of cap.scenarios ?? []) checkRef(`${where} scenario`, ref);
    for (const ref of cap.evidence ?? []) checkRef(`${where} evidence`, ref);
    if (cap.spec_ref) checkRef(`${where} spec_ref`, cap.spec_ref);
    if (cap.parity) checkRef(`${where} parity`, cap.parity);
  }
}

function loadRegistry(path: string): Registry {
  return JSON.parse(readFileSync(path, "utf8")) as Registry;
}

function selfTest(): void {
  const good = {
    schema_version: 1,
    contracts: [
      { id: "c1", version: 1, title: "t", spec: "docs/migration/README.md", oracle: "conformance" },
    ],
    capabilities: [
      {
        id: "ok.cap",
        title: "t",
        area: "a",
        owner: "app",
        boundary: "B1",
        contracts: ["c1@1"],
        os: ["macos"],
        operations: ["op"],
        scenarios: ["docs/migration/README.md"],
        evidence: ["issue:1"],
        stage: "current-verified",
        status: { implemented: true },
      },
    ],
  };
  const cases: Array<[string, unknown, boolean]> = [
    ["valid registry passes", good, true],
    [
      "verified stage without evidence fails",
      { ...good, capabilities: [{ ...good.capabilities[0], scenarios: [], evidence: [] }] },
      false,
    ],
    [
      "unimplemented at verified stage fails",
      {
        ...good,
        capabilities: [{ ...good.capabilities[0], status: { implemented: false } }],
      },
      false,
    ],
    [
      "unresolved contract ref fails",
      { ...good, capabilities: [{ ...good.capabilities[0], contracts: ["missing@9"] }] },
      false,
    ],
    [
      "duplicate capability id fails",
      { ...good, capabilities: [good.capabilities[0], good.capabilities[0]] },
      false,
    ],
    [
      "missing path evidence fails",
      { ...good, capabilities: [{ ...good.capabilities[0], evidence: ["docs/nope.md"] }] },
      false,
    ],
    [
      "excluded at non-not-started fails",
      {
        ...good,
        capabilities: [
          { ...good.capabilities[0], status: { implemented: false, excluded: true } },
        ],
      },
      false,
    ],
  ];
  let failed = 0;
  for (const [name, reg, shouldPass] of cases) {
    errors.length = 0;
    validate(reg as Registry);
    const passed = errors.length === 0;
    if (passed !== shouldPass) {
      console.error(`self-test FAIL: ${name} (errors: ${errors.join("; ")})`);
      failed++;
    }
  }
  if (failed > 0) {
    console.error(`self-test: ${failed} case(s) failed`);
    process.exit(1);
  }
  console.log("self-test: PASS");
}

if (process.argv.includes("--self-test")) {
  selfTest();
} else {
  const reg = loadRegistry(REGISTRY_PATH);
  validate(reg);
  if (errors.length > 0) {
    for (const e of errors) console.error(`registry: ${e}`);
    console.error(`registry: ${errors.length} violation(s)`);
    process.exit(1);
  }
  const count = reg.capabilities?.length ?? 0;
  console.log(`ok      migration registry valid (${count} capabilities, ${reg.contracts?.length ?? 0} contracts)`);
}
