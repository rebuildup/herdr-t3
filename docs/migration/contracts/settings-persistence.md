# Contract: settings and persistence (B7)

Version: 1. Scope: renderer- and OS-persisted user state — settings,
history, keybindings, layout prefs, connection definitions, drafts —
and the desktop profile (`userData`) layout. Deep compatibility
matrix: #239. This contract fixes ownership and observable behavior;
file formats may evolve only through the #239 compatibility rules.

## Operations

- Settings sections (each one typed store, one storage key — no second
  source of truth):
  - `herdr-t3:settings:terminal` — fontFamily, fontSize, lineHeight,
    scrollbackLines, copyOnSelect (`src/lib/settings.ts`).
  - `herdr-t3:settings:general` — confirmCloseWorkspace.
  - Appearance mode lives in `src/lib/theme.ts` (also drives the OS
    theme bridge); launch-at-login lives in the OS, read/written only
    through desktop IPC — never duplicated in renderer storage.
- Machines/connections: persisted via herdr `machine` commands
  (server-side), not renderer storage.
- Drafts (typed-but-unsent pane messages): in-memory only; survive
  disconnect, never auto-send, discarded explicitly by the user.
- Legacy organize overlay `herdr-t3:sidebar:agents:organize`
  (localStorage): migration input for ADR-0011; not authoritative.

## Ordering and semantics

- Every persisted value has exactly one owner/key; reads tolerate
  missing/corrupt JSON by falling back to defaults (current behavior —
  #239 decides whether corruption should surface instead).
- Settings apply live where the UI supports it (terminal font/size,
  theme); others apply on next launch — the contract records which.
- `userData` is profile-scoped: dev builds use `herdr-t3-dev` so they
  never touch the stable profile (`desktop/main.ts`).

## Errors

- Corrupt/unknown fields → defaults for that field; unknown keys are
  preserved or dropped per #239 schema rules (forward-compat decision
  pending — do not assume).
- Storage unavailable (private mode etc.) → in-memory defaults; no
  crash, no partial writes presented as saved.

## Negative cases

- two stores writing the same setting key;
- renderer persisting launch-at-login or machine credentials;
- draft surviving app restart (must not — restart loses drafts by
  design; verify this is intended and recorded);
- settings written by a newer version silently corrupting an older
  install's read (rollback compatibility — #239).

## Evidence today

`src/lib/settings.test.ts`, `src/lib/theme.ts`, `src/lib/localStorage.ts`,
`desktop/main.ts` (userData, diagnostics), `docs/development.md`
(pc-setup profile ownership). Round-trip/fault-injection contracts: #239.
