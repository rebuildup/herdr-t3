# Migration policy — Electron → Rust/GPUI (canonical, ADR-0013)

Program: issue #233. Tickets: #234 (this policy), #235 (capability
registry + behavioral contracts), #237–#240 (harnesses), #241 (CI /
readiness / roadmap). This document is the single canonical policy for
the staged migration; ADRs record decisions, this file records the
standing rules.

## 1. Inherited invariants (from #233, binding on every ticket)

- Contract-first, verification-first. External observable behavior is
  fixed and verified before replacement; the normative spec is kept
  separate from the current implementation's actual behavior.
- No capability regression: functionality, operability, visual quality,
  data compatibility. Electron and GPUI implementations are judged by the
  same scenarios and the same criteria; implementation-specific
  assertions (DOM, React, Rust types) stay inside adapters.
- Staged replacement per verifiable boundary, single state ownership,
  no Rust→Electron/Node/Bun reverse dependency. Rollback must not lose
  settings, history, workspaces, or running herdr sessions. Dual
  implementation exists only inside a migration window with a
  pre-defined removal condition.
- Performance non-regression is measured, not assumed. Ghostty VT
  semantics and state ownership (ADR-0007) are preserved; engine choice
  is evidence-driven.
- AGENTS.md §3/§4/§5, ADR-0007/0008/0009/0011/0012, the #188 parity
  program, macOS + Windows 11 targets, and the pc-setup distribution
  path are maintained. herdr owns PTY/scrollback/agent state; plugins
  own feature state. Tests never point at the live herdr session.
- Release discipline follows `organization/profiles/release-driven-solo.md`
  and ADR-0036: ticket PRs get static/local/contract/diff-scoped checks;
  the release branch gets integration; the frozen release candidate gets
  the full E2E + both-OS + performance + artifact + visual suite on one
  SHA. `quality/profile.yaml` and the real CI must agree; skipped or
  unrunnable verification is never a pass.
- #188 publication is not blocked by this program; the migration does
  not freeze existing features, and new #188 capabilities enter the
  registry under the same rules.

## 2. Current architecture and state ownership

```
┌─ Electron main (desktop/main.ts, Node) ────────────────────────────┐
│  window lifecycle, nativeTheme watcher, diagnostics, userData      │
│  MachineManager ── bridge session ── herdr socket / SSH / plugins  │
└──────────────┬────────────────────────────────────────────────────┘
               │ IPC: ClientFrame / ServerFrame  (shared/protocol.ts)
┌──────────────┴────────────────────────────────────────────────────┐
│ preload.cjs (contextBridge) ── typed bridge, no raw IPC escape     │
└──────────────┬────────────────────────────────────────────────────┘
               │ same frame contract
┌──────────────┴────────────────────────────────────────────────────┐
│ renderer src/ (React + Vite + Tailwind/Base UI)                   │
│  shell/ (T3 app shell), components/ui, lib/ghostty (per-pane       │
│  GhosttySession → shared/ghostty engine WASM, terminal-io.md)     │
└───────────────────────────────────────────────────────────────────┘

Dev path: `bun run server` (server/) exposes the same frames over
HTTP/WS; bridge-core.ts is shared between dev server and Electron main.
```

State ownership today:

| Domain | Owner | Persistence |
| --- | --- | --- |
| pty, scrollback, agent state | herdr (remote or local) | herdr session |
| plugin feature state (inbox, git, …) | herdr-plugins on the herdr host | plugin state files (never read by herdr-t3) |
| workspace/tab/pane projection, drafts, UI state | renderer stores (`src/shell/*`) | session snapshot from bridge; drafts in memory |
| user settings, machines, keys | renderer + Electron `userData` | localStorage / profile files (see #239 inventory) |
| organize-state legacy overlay | `src/shell/agentOrganizeStore.ts` localStorage | one-time migration to plugin state (#173 → ADR-0011) |

## 3. Candidate migration boundaries

Ordered roughly by dependency depth (final order is set by #241 from
measured readiness, not this list):

| # | Boundary | Current implementation | Contract surface | State owner |
| --- | --- | --- | --- | --- |
| B1 | Protocol / frame codec | `shared/protocol.ts` | versioned ClientFrame/ServerFrame, `isClientFrame`, snapshot/revision semantics | bridge ↔ UI (stateless transport) |
| B2 | herdr bridge core | `server/bridge-core.ts`, `herdr.ts`, `ssh.ts`, `plugins.ts`, `machines*.ts`, `machine-manager.ts` | herdr RPC/subscribe/attach, SSH transport, plugin_list/plugin_call, snapshot/reconnect semantics (AGENTS.md §3) | herdr session (remote); bridge holds none |
| B3 | State projection | snapshot → `src/shell/*` stores, `agents.ts`, `inbox.ts`, `git.ts`, `worktrees.ts`, `goto.ts` | derived views, ordering, attention/dock semantics | app (derived; source of truth stays upstream) |
| B4 | Terminal engine / frame | `shared/ghostty/engine.ts` + WASM, `src/lib/ghostty/{session,surface,renderer,keys,colors}.ts`, `inputPolicy.ts` | byte-level I/O contract `docs/design/terminal-io.md`, cell grid/attrs/scroll/selection | per-pane emulator (app-owned, mirrors herdr truth via attach stream) |
| B5 | Streaming / render scheduling | `PaneTerminal.tsx`, renderer batching (#213), resize/scroll throttle | frame cadence, dirty-row, scroll-follow, input-to-paint | app |
| B6 | Pane / UI composition | `src/shell/*`, `src/components/**` | semantic actions/targets, T3 design semantics (`docs/design/*`) | app |
| B7 | Settings / persistence / OS integration | `desktop/main.ts`, `desktop/preload.cjs`, SettingsModal, localStorage/profile | settings schema, window chrome, theme watcher, diagnostics, clipboard/IME hooks | app (userData) |
| B8 | Distribution | `scripts/build-desktop.ts`, electron-builder, pc-setup | install/update/rollback, bundle contents | release pipeline |

Dependency direction (must stay acyclic toward the core):

```
B8 distribution ──> B7 OS/shell ──> B6 UI ──> B5 render ──> B4 terminal
      │                 │              │          │           │
      └────────────> B3 state projection <── B2 bridge <── B1 protocol
```

Rules:

- B1 (protocol) is the only contract every other boundary may depend on;
  it is versioned and changes go through an ADR when wire-incompatible.
- B2 may be hosted by either runtime during transition (today: Bun dev
  server + Electron main). A Rust bridge implementation must speak B1
  and preserve every AGENTS.md §3 invariant; the invariants are
  individually testable negative cases (#237).
- B4's contract is `terminal-io.md`, not the WASM build. The Rust side
  may keep WASM libghostty-vt, use a native core, or split
  engine/frame — decided per evidence, with the same byte/cell
  conformance suite.
- No boundary may reach around another: UI never talks to herdr
  directly; bridge never renders; persistence never duplicates plugin
  or herdr state.

## 4. Gates

### 4.1 Migration start (per capability)

A capability may enter implementation only when:

1. its contract (behavioral spec) exists and is implementation-
   independent (#235);
2. current-implementation conformance evidence exists for the
   representative scenarios (#237/#238 as applicable);
3. rollback path is defined: the current implementation remains
   switchable until cutover, and cutover is reversible without data
   loss;
4. the capability's stage in the registry is `contract-defined` or
   better, with evidence links.

### 4.2 Cutover (switch)

1. Rust/GPUI implementation passes the same scenario suite as the
   current one (differential + conformance oracles are separate
   judgments — see #237);
2. performance non-regression holds on the measured baseline (#240);
3. persistence/OS compatibility contracts hold (#239) where applicable;
4. UI-facing capabilities additionally satisfy `design-system@1`
   (issue #412, §4.5): inherited token/primitive/composition rules and
   T3-reference visual comparison evidence;
5. both implementations coexist only inside the window; the registry
   records which is authoritative.

### 4.3 Old-implementation removal

Removal requires, per capability: equivalence evidence at the frozen
candidate SHA, both-OS verification where the capability is OS-facing,
performance evidence, data round-trip/restore evidence where state is
involved, and the registry stage advanced to `removed` with evidence
links. "Compiles" or "demo works" is not removal evidence.

### 4.4 Final Electron removal gate

Electron and the Node/Bun runtime dependencies are removed only when
every in-scope capability is `removed`-stage with evidence, persisted
data migrates losslessly (round-trip + old→new→old verified), the
packaged artifact on macOS and Windows 11 launches and passes the RC
suite, herdr/plugin ownership is unchanged, and the dependency tree /
distribution artifact contains no Electron and no unnecessary
Node/Bun runtime. This gate is independent and is **not** part of this
program's delivery.

### 4.5 Design-system conformance (issue #412)

The T3 Code design-system machinery established by #407
(`docs/design/conformance-audit.md`) and the #409–#411 surface
re-implementations is a **capability-level requirement**, not a
one-time port: every UI-rendering capability inherits it on the
GPUI/Rust target through contract `design-system@1`
(`docs/migration/contracts/design-system.md`), which all B6
capabilities must pin (registry-enforced).

- **Canonical sources are inherited, not re-derived.** Tokens
  (`src/index.css` roles), primitives (`src/components/ui/*` and the
  `surfaceLayout` composition layer), composition rules, the type
  hierarchy, and the state-primitive requirements (`Empty*`/`Skeleton`/
  `Alert`/toast) are the spec; GPUI equivalents reproduce the
  semantics, not the DOM. Deliberate non-ports recorded in the audit
  (e.g. `ui/table.tsx` — T3's UsagePage uses raw table markup) are part
  of the spec.
- **Acceptance requires visual-diff evidence.** Cutover/equivalence for
  UI-facing capabilities includes the `docs/design/verification.md`
  pipeline: captures on an isolated herdr session at fixed
  viewport/theme/font/DPI, side-by-side T3 Code reference comparison,
  and recorded verdicts. Semantic ui-conformance scenarios and visual
  fidelity are separate judgments; neither substitutes for the other.
  Pixel-perfect equality is not required — deviations must be
  deliberate and justified.
- **Lint-equivalent on Rust/GPUI** is layered: semantic contract tests
  for token roles and state mapping, the ui-conformance scenario suite
  on both adapters, visual-diff review, and manual composition/density
  review at RC — there is no Rust port of oxlint, and none is implied.

## 5. Toolchain and code policy (for the Rust side)

- Rust toolchain is managed by `mise` alongside bun/node
  (`mise.toml`/`mise.lock` are the pin source); CI installs via the same
  file. No floating `stable` assumptions — record the pinned version.
- Cargo workspace layout and crate naming follow `code-naming`:
  responsibility-named crates under a single workspace root; no
  `utils`/`common` dumping grounds; one-way dependencies enforced by
  workspace structure and reviewed in PRs.
- `safe Rust` is the default. `unsafe` and FFI (terminal core, platform
  APIs, any C/C++ dependency such as a native Ghostty build) are
  localized behind narrow modules with documented safety contracts;
  `cargo deny`/equivalent advisory + license checks run in CI.
- License compatibility is checked per dependency (MIT/Apache-2.0
  project; Apache-2.0 GPUI is compatible). Vendored or adapted material
  updates `THIRD_PARTY_NOTICES.md`.
- OS-specific code lives in clearly named platform modules
  (`*_macos`, `*_windows` or `cfg`-gated modules), never scattered
  `if windows` branches in shared logic.
- Worktrunk/Cargo build-output isolation follows the project-init
  worktree policy; caches are shared per the existing profile.
- The Rust side never shells out to Electron/Node/Bun APIs; where a
  capability genuinely requires a host runtime during transition, the
  dependency direction in §3 decides which side hosts it.

## 6. GPUI evaluation plan (gate input, not a decision)

Facts established at authoring time (2026-11-25, re-verify at spike):

- GPUI is Zed's GPU-accelerated Rust UI framework, Apache-2.0,
  pre-1.0 with breaking changes between versions.
- crates.io `gpui` 0.2.2 (2025-10-22) predates the platform split and
  cannot express current standalone usage; current standalone apps use
  `gpui-platform`/snapshot crates tracking the Zed repository (e.g.
  `gpui-pre`). The exact dependency source and pin are a spike output.
- Platform coverage now includes Windows (`gpui_windows`: Win32,
  DirectWrite, DirectComposition/D3D11, accesskit accessibility,
  IME APIs) — but coverage claims must be verified by the spike, not
  assumed.

Minimal non-product spike (its own ticket after readiness planning;
allowed before product porting per #233):

1. Pin a GPUI revision/source; build a trivial window on macOS and
   Windows 11 via CI or documented manual runs.
2. Verify: text rendering incl. CJK, IME composition + candidate
   window anchoring, clipboard read/write, keyboard shortcuts,
   window chrome/titlebar control (needed for ADR-0008 shell),
   HiDPI/DPI scaling, accessibility tree presence, idle CPU/RSS and
   binary/bundle size vs the Electron baseline.
3. Verify embeddability: can a GPUI view host or interoperate with the
   terminal surface contract (cell grid rendering path), or is a
   custom element needed — record which.
4. Record results as evidence in the capability registry / an ADR;
   any failed required capability blocks the UI boundary's readiness.

Design-semantics mapping: T3 tokens/primitives behavior are the spec;
GPUI's Tailwind-like styling API is an implementation detail. The UI
conformance harness (#238) asserts semantic scenarios, so a GPUI adapter
and the current Electron adapter run the same suite. Design-system
conformance beyond semantics — tokens, primitives, composition, visual
fidelity — is governed by `design-system@1` and §4.5 (issue #412).

## 7. Open items carried to later tickets

- Capability registry schema and first inventory (#235).
- Behavioral contract format and the bug-vs-spec ledger (#235).
- Differential harness adapters and fault-injection set (#237).
- UI conformance scenario format + GPUI test host evidence (#238).
- Persistence/OS compatibility matrix and fixture set (#239).
- Performance baseline workloads, thresholds derived from measurement
  (#240; #231 is a starting point, not the verdict).
- CI/readiness machine check and migration roadmap ordering (#241).
