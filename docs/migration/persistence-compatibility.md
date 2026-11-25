# Persistence / OS compatibility contract (issue #239)

Deep compatibility rules for every byte herdr-t3 persists or depends on,
per `docs/migration/contracts/settings-persistence.md` (B7, v1) and
`distribution.md` (B8). This document is the authority for format
versions, migration, and rollback; the contract doc fixes observable
behavior. Nothing here authorizes a product port — it defines what a
future Rust/GPUI implementation must read and write identically.

## 1. Persistence inventory

| Store | Owner | Format | Location | Writers |
|---|---|---|---|---|
| `herdr-t3:settings:terminal` | herdr-t3 renderer | JSON object, unversioned | Chromium Local Storage under Electron `userData` | `src/lib/settings.ts` only |
| `herdr-t3:settings:general` | herdr-t3 renderer | JSON object, unversioned | same | `src/lib/settings.ts` only |
| `herdr-t3:appearance` | herdr-t3 renderer | bare string enum (`ghostty\|system\|dark\|light`) | same | `src/lib/theme.ts` only |
| `herdr-t3:sidebar-open`, `herdr-t3:sidebar-width` | herdr-t3 renderer | boolean / number-as-string | same | `src/components/ui/sidebar.tsx` via `src/lib/localStorage.ts` |
| `herdr-t3:sidebar:agents:organize` | **legacy** — superseded | JSON map `machine\npane → {kind, seq}` | same | read-once migration input only (`src/shell/agentOrganizeStore.ts`, ADR-0011 §8); never authoritative, never a fallback |
| Drafts (unsent pane input) | herdr-t3 renderer | **in-memory only** | — | survives disconnect, never survives restart, never auto-sent (AGENTS.md §3) |
| Keybindings / shortcuts | herdr-t3 renderer | code constants (`src/lib/shortcuts.ts`) | — | not user-persisted today |
| Machine/connection definitions | **herdr** | `<state>/client/endpoints.json` `{version:1, ssh:[{id,label,target,session,enabled}]}` | `server/machines.ts` `stateDir()` | herdr only — herdr-t3 is read-only |
| Per-machine SSH metadata | **herdr** | `<state>/client/ssh-metadata/<id>.json` `{metadata:{os,executable}}` | same | herdr only |
| Agent organize (canonical) | **plugin** `rebuildup.inbox` | plugin-owned records on target host | remote | plugin boundary only (ADR-0011) |
| `userData/bridge-status.json` | herdr-t3 desktop | JSON status snapshot | Electron `userData` | `desktop/main.ts`; status only, grants nothing |
| `userData/logs/` | herdr-t3 desktop | text logs | Electron `userData` | `desktop/main.cjs` diagnostics |
| Launch at login | OS | OS-owned | OS | desktop IPC only; never duplicated in renderer storage |

`userData` root: macOS `~/Library/Application Support/herdr-t3`
(`herdr-t3-dev` for dev builds — stable profile is never touched);
Windows `%APPDATA%\herdr-t3` (`%APPDATA%\herdr-t3-dev` dev). Evidence:
`docs/design/evidence/90/manifest.json` (v0.2.2→0.3.0 upgrade kept
settings; rollback read the same state).

herdr `stateDir()`: `$XDG_STATE_HOME/herdr` or `~/.local/state/herdr`
on Unix; `%LOCALAPPDATA%\herdr` (fallback `%USERPROFILE%\AppData\Local\
herdr`) on Windows. herdr-t3 must never write these paths.

## 2. Format rules (current behavior, frozen as contract)

1. **One owner per key.** Each persisted value has exactly one storage
   key and one writer module (table above). A second writer is a defect.
2. **Unversioned JSON, tolerant reads.** Settings payloads carry no
   `version` field. Reads tolerate: missing key, invalid JSON, non-object
   JSON, wrong-typed fields, out-of-range numbers (clamped), unknown
   fields.
3. **Unknown fields are dropped on rewrite.** `set*Settings` serializes
   the parsed object, so fields a newer version added are discarded when
   an older build next saves. Forward-compat rule: **a newer version
   must not persist fields an older supported version cannot safely
   ignore-and-drop** unless data loss is acceptable — today every field
   is ignorable, so this holds. If a future field is NOT safe to drop,
   it requires a schema version bump (new key or `version` field) — that
   is a contract change requiring ADR + Issue.
4. **Corruption → per-field defaults, never crash.** Malformed JSON or
   storage exceptions fall back to defaults / in-memory operation.
   Partial multi-key state is possible (keys are independent); there is
   no cross-key transaction — acceptable because sections are
   independent.
5. **Atomicity.** Each `localStorage.setItem` is atomic per key (Chromium
   guarantee). Writes are single-key; no multi-key commit protocol
   exists or is needed.
6. **Drafts are volatile by design.** Restart loses drafts; this is
   recorded intent, not a bug. A migration must not "fix" it by
   persisting drafts.
7. **Ownership boundaries.** herdr owns machines/endpoints/pty/scrollback;
   plugins own their records (inbox organize); the OS owns launch-at-
   login; Electron `userData` owns renderer storage + desktop status/
   logs. A GPUI/Rust port must keep the same ownership split — renderer
   state moves to a new profile location only via an explicit,
   tested migration (§4), never by dual-writing.

## 3. OS compatibility matrix

| Concern | macOS | Windows 11 | Contract |
|---|---|---|---|
| Renderer profile | `~/Library/Application Support/herdr-t3` | `%APPDATA%\herdr-t3` | dev builds use `-dev` suffix; never share |
| herdr state | `$XDG_STATE_HOME` or `~/.local/state/herdr` | `%LOCALAPPDATA%\herdr` | read-only for herdr-t3 |
| herdr socket | unix socket `herdr.sock` | `herdr.sock` is a marker; named pipe `\\.\pipe\<path>` | AGENTS.md §3 |
| SSH machines | `ssh` transport | same | `endpoints.json` schema identical |
| Launch at login | OS login item via desktop IPC | same via IPC | never in renderer storage |
| IME / clipboard / window lifecycle / keyboard / DPI | per-OS evidence required at RC | same | tracked under `os.*` capabilities; OS-real-device evidence is collected at release-candidate freeze, not per-ticket |
| Distribution | electron-builder dir → pc-setup `install.sh` | `install.ps1`, `update.ps1`, `rollback.ps1` | `rebuildup/pc-setup` `components/herdr-t3` — **upstream dependency**; this repo must not modify pc-setup without an explicit upstream Issue. Rollback = pointer flip to `previous` build, no data migration (evidence/90 windows README) |

## 4. Migration / rollback rules for the future port

- **Read-old, write-new is forbidden without a plan.** The port may add
  a new profile location, but must define: import-from-Electron path,
  export-back path, and what happens to the Electron profile afterwards
  (leave untouched = rollback-safe; delete = irreversible, needs
  explicit user action).
- **Round-trip requirement.** For every store in §1: old build writes →
  new build reads → new build writes → old build reads, with no
  semantic loss beyond documented drops. Contract tests
  (`src/lib/persistence-compat.test.ts`) pin the current semantics so a
  Rust implementation can be diffed against them.
- **Failure injection set** (must all be covered by tests):
  corrupt JSON, truncated JSON, valid JSON wrong type (array/string/
  number), unknown extra fields, missing fields, out-of-range numbers,
  storage throwing on read and on write, concurrent writers (last-write-
  wins per key is acceptable and must be documented), app killed
  mid-write (per-key atomicity makes this safe — verify, don't assume).
- **No dual state ownership.** During transition exactly one
  implementation owns each store at a time; the other is read-only or
  absent. Two writers to one key is a release blocker.
- **herdr/plugin state is out of scope for migration** — it survives any
  client swap by definition; tests must prove the client never writes
  it (existing `server/machines.ts` read-only posture + guard tests).

## 5. Contract tests

`src/lib/persistence-compat.test.ts` exercises, against an isolated
`MemoryStorage` (never a real profile):

- round-trip: write → stored JSON → parse → identical semantics
- old→new→old: a payload containing only the fields an older version
  knew round-trips unchanged; unknown fields are dropped on rewrite
  (documents §2.3 — the forward-compat decision is "drop", recorded)
- fault injection: corrupt/truncated/wrong-type JSON → defaults;
  out-of-range → clamped; storage throwing → in-memory defaults, no
  throw; `null`/`undefined` field values → defaults per field
- single-owner: each settings key is written only by its module
  (structural check via storage key enumeration in test)

Live-profile and real-OS evidence (upgrade/rollback on both OSes,
crash-mid-write) is deferred to release-candidate freeze per #239/#241 —
do not mark those verified from unit tests alone.
