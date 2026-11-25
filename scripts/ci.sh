#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

printf 'Checking TypeScript...\n'
bun run typecheck

printf 'Running tests...\n'
bun run test

printf 'Running differential harness (rust adapter)...\n'
cargo build -p diff-adapter -p protocol-codec -p state-projections
cargo test -p protocol-codec -p state-projections
bun harness/run.ts harness/scenarios --adapters rust

printf 'UI lint...\n'
bun run lint:ui

printf 'Checking ADR index...\n'
python3 - <<'PY'
import re
from pathlib import Path

adr_dir = Path("docs/adr")
index = (adr_dir / "README.md").read_text(encoding="utf-8")
indexed = set(re.findall(r"\((?:\./)?(ADR-\d{4})\.md\)", index))
present = {path.stem for path in adr_dir.glob("ADR-*.md")}
missing = present - indexed
if missing:
    raise SystemExit(f"ADRs missing from index: {sorted(missing)}")
print("ok      ADR index covers all ADR files")
PY

printf 'Checking migration registry...\n'
bun scripts/check-migration-registry.ts
bun scripts/check-migration-registry.ts --self-test

printf 'Checking UI conformance scenarios...\n'
bun scripts/check-ui-scenarios.ts

printf 'Checking migration readiness...\n'
bun scripts/check-migration-readiness.ts
bun scripts/check-migration-readiness.ts --self-test

printf 'All repository checks passed.\n'
