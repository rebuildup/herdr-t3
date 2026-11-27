# Anti-case ledger — design-system quality loop (issue #407)

Canonical ledger of known undesirable UI outcomes ("anti-cases") for the
herdr-t3 design system, per the 2026-11-27 policy revision in #407 and the
application issue #534. Each entry records the case ID, evidence, root
cause, applicable scope, the planned detection method, positive/negative
fixtures, implementation status, and the scope the check does **not**
guarantee.

This file is the SoT for case identity and status. `rules.md` holds the
lint-level rules, `conformance-audit.md` the audit record; neither replaces
this ledger. New anti-cases discovered in review or on-device use are
appended here with the same fields — a finding without a ledger entry is
not tracked.

## Entry schema

| Field | Meaning |
| --- | --- |
| ID | `AC-NNN`, stable, never reused |
| Statement | The undesirable outcome in observable terms |
| Evidence | User report / capture / code location |
| Root cause | Why the outcome happened (mechanism, not symptom) |
| Scope | Where the contract applies |
| Detection | Planned mechanical check (lint rule, AST, type, DOM/geometry test, review) and its honest limits |
| Fixtures | Negative fixture (must be rejected) + positive control (must pass) |
| Status | `open` → `fix+gate landed` → `verified`; `verified` requires both fixtures exercised by the real check |
| Unguaranteed | What this case's check explicitly does not prove |

## Iteration protocol (per #407)

1. Extract the anti-case from real screens, usage, or the T3 reference
   (`9cc4018c75ff`, see `docs/upstream.md`) — describing responsibility,
   state contract, structure, derived dimensions, and operation meaning,
   not just pixels.
2. Reproduce in real code why the current gate let it pass. A prose rule,
   an existing primitive, a warning, or a self-report is not a pass.
3. Make the invalid form unrepresentable where possible (types, shared
   primitives/slots/variants, state types, layout structure); detect the
   remainder with AST/type/dependency/token checks that fail CI. Rendered
   size, wrapping, overlay, and state transitions are verified by
   DOM/geometry/operation-contract tests; meaning and aesthetic merit stay
   with independent rendered review. Static analysis limits are stated,
   never papered over.
4. Fix the known violation and land the rejection mechanism in the same
   change unit. Prove the anti-case can no longer pass the acceptance path
   and that legitimate cases still pass. Check escape routes: alternate
   spellings, indirect components, exceptions/suppressions, uncovered
   scopes. Exceptions carry rationale, scope, and a review condition — no
   permanent blanket allowlists; existing debt is itemized, not waived.
5. Record case ID, rationale, scope, check method, positive/negative
   examples, implementation/evidence, and unguaranteed scope here.

## AC-001 — Settings modal height is content-derived, not viewport-derived

**Statement.** The settings modal's vertical size changes with the active
section's content height instead of holding the intended stable,
viewport-derived geometry. Sparse sections produce a shrunken modal;
dense sections hit the cap. Switching settings sections visibly resizes
the dialog — the user-reported "設定モーダルの縦幅が変わった".

**Evidence.** User report on the deployed 0.7.0 build (2026-11-27,
#407 policy revision). Code: `src/shell/SettingsModal.tsx` popup class
`sm:h-auto` added by `cedcd71` ("fix(ui): address RC v0.6.0 z5 visual
review findings (#480)").

**Root cause.** The modal was created in `8a194ab` (issue #83) as a
`size-full` popup inside a padded, centered viewport
(`sm:p-6 sm:pt-(--app-modal-sm-top) lg:p-10`, `sm:max-h-[60rem]`): height
was derived from the viewport, stable across section switches, with the
nav rail and the content column each owning an internal
`overflow-y-auto` scroll region. The z5 review listed "settings modal
oversized empty area" as a *minor, ambiguous* finding (#480 item 11,
marked `[verify]`). The fix treated the whitespace symptom by changing
the sizing contract — `sm:h-auto` makes the popup hug intrinsic content
height — instead of addressing whitespace inside a stable frame. Result:
the dialog's height is now a function of section content, so every
section switch re-lays-out the modal. There is no T3 modal counterpart
to copy: T3 Code settings is a routed page (`/settings/*`,
`SettingsPageContainer` → `WorkspacePageContainer`) that fills the
workspace and scrolls internally — i.e. upstream's own contract is
"frame derived from the container, content scrolls", which is exactly
the pre-`cedcd71` behavior.

**Scope.** `SettingsModal` and any future app-modal (`data-app-modal`)
whose height must be stable across internal navigation.

**Detection (planned).** Rendered-geometry contract, not lint: a UI
scenario / DOM test that opens the settings modal, measures popup height
on a sparse section and a dense section, switches sections, and asserts
the height is unchanged (within rounding) and bounded by viewport /
`max-h-[60rem]`. Static class inspection cannot prove derived geometry;
this check's honest limit is that it verifies the contract on the tested
viewports/sections only.

**Fixtures.** Negative: current `sm:h-auto` popup — height varies by
section (reproduces the regression). Positive: viewport-derived height
with per-region scroll ownership — height identical across sections,
content scrolls internally.

**Status.** `open` — RCA recorded; fix direction is restoring
viewport-derived height (revert `sm:h-auto`) while handling the z5
whitespace observation inside the content column, not by re-deriving
height from content. Detection check not yet implemented.

**Unguaranteed.** Whether the whitespace itself is aesthetically
acceptable is a review property (#413), not proven by the geometry check.
Mobile (`max-sm`) full-bleed sheet behavior is a separate contract and
is not covered by the sm+ assertion.

## AC-002 — Frequent actions rendered as explanatory text instead of icon controls

**Statement.** Row-level and section-accessory actions that T3 expresses
as icon buttons (`size="icon-xs"`/`"icon-sm"`/`"icon-micro"` + accessible
name + tooltip) are rendered in herdr-t3 as `size="xs"`/`"sm"` text
buttons, often with redundant icons *and* explanatory labels, so dense
surfaces accumulate text chrome T3 does not have.

**Evidence.** User report (#407 policy revision). Representative
instances on `release-0-7-0` (inventory to be completed by the #534
surface audit):

- `GitSurface.tsx` — section actions "Reload"/"Refresh" (`size="xs"`
  ghost, ~lines 1165, 1676, 1727, 1802)
- `ProjectScriptsSurface.tsx` — "Refresh" action (~line 701)
- `ProjectsSurface.tsx` — "Discover repos"/"Refresh" (~line 575)
- `AutomationsSurface.tsx` — "Enable", "Run now", "Delete", "Reconcile"
  row actions (~lines 336–371, 560)
- `HandoffsSurface.tsx` — "Execute"/"Delegate"/"Merge back" (~lines
  1072–1097), refresh (~1540)
- `SecretsSurface.tsx` — "Probe reachability", "Preview resolve"
  (~lines 146–153, 341–348)
- `ConversationsSurface.tsx` — "Load more", index-now, refresh
  (~lines 465, 669, 767–786)

T3 reference: settings rows and panel headers use `size="icon-*"` ghost
buttons with `aria-label` + `Tooltip` for repeated accessory actions
(`apps/web/src/components/settings/*.tsx`, e.g. `IssueTrackerSettings`,
`KeybindingsSettings`, `settingsLayout.tsx` hover-reveal row actions);
text buttons are reserved for primary/one-off actions whose meaning is
not icon-obvious.

**Root cause.** The #409–#411 rewrites gave surfaces shared action slots
(`SurfacePanelHeader actions`, `SurfaceDetailsSection actions`, row
action clusters) but no contract distinguishes "frequent accessory
action → icon control" from "primary/rare action → text button is
fine". `ui/button.tsx` already ships every T3 icon size; the gap is
usage, not primitives. Lint has no rule for action semantics, and the
fixtures only cover token/class hygiene.

**Scope.** All plugin surfaces and shell surfaces; applies to repeated
row actions and section-header accessory slots. Explicitly does **not**
apply to primary CTAs, form submits, destructive confirms, or actions
whose meaning genuinely needs a label.

**Detection (landed).**

1. `herdr-t3/no-text-button-in-surface-slot`
   (`lint-plugin/rules/no-text-button-in-surface-slot.ts`, error in
   `.oxlintrc.json`) flags non-`icon-*` `size` `Button`s inside the
   `actions`/`action` props of `SurfacePanelHeader`, `SurfaceSection`,
   `SurfaceDetailsSection`, and `SurfaceGroupHeader`. Suppressions need
   a reason (`require-suppression-reason`).
2. The shared `IconAction` wrapper from the original plan was not
   introduced: the established conforming pattern
   (`size="icon-*" variant="ghost"` + `aria-label` + `title`/tooltip +
   icon) already exists at multiple call sites, and the lint rule
   enforces the slot boundary directly. Revisit only if review shows
   the per-site pattern drifting.

Honest limit: static analysis can enforce the slot/size boundary but
cannot judge whether a given action's meaning requires text — that
classification is recorded per call site and reviewed; the rule blocks
*new unlabeled-in-spirit* regressions, it does not auto-approve meaning.
Row-level action clusters outside the four header slots (e.g. Handoffs
"Execute"/"Delegate" buttons) are not yet covered by the rule and are
part of the #534 audit.

**Fixtures.** `scripts/lint-fixtures/bad.tsx` carries a `size="xs"`
"Refresh" text button inside `SurfacePanelHeader actions` (asserted by
`scripts/lint-ui.test.ts`); `good.tsx` carries the `size="icon-xs"`
ghost + `aria-label` positive control.

**Fix delivered.** All 13 inventoried violations converted to the icon
pattern: `ProjectScriptsSurface` (1), `ProjectsSurface` (1),
`GitSurface` (5 — remotes/branch/PR reload, group stage/unstage,
show/hide form), `ConversationsSurface` (2), `AutomationsSurface` (2).
`oxlint src` reports zero errors for the rule.

**Status.** `fix+gate landed` — rule + fixtures + all known slot
violations delivered in the #407 ticket PR. Rendered verification of
the converted controls rides with the release-candidate review (#413);
row-cluster coverage remains audit work under #534.

**Unguaranteed.** Does not prove every remaining text button is
misclassified; borderline cases (rare but ambiguous actions) stay a
review property. Does not cover tab-strip iconography beyond the cases
the audit enumerates.

## AC-003 — Badge used as generic metadata chip

**Statement.** `Badge` is used for ordinary metadata — kind/type labels,
paths, counts, guard on/off flags, provider kinds, lineage kinds — so
surfaces accumulate badge chrome where T3 reserves `Badge` for states
and classifications that carry meaning.

**Evidence.** User report (#407 policy revision). `grep -c "<Badge"` on
`release-0-7-0`: 149 usages across 20 files. Clear violations:

- `TextGenSurface.tsx` (16) — `task.kind` as `variant="info"`,
  `agent`/`api` provider-kind badges, path badges, guard flags
  ("expensiveTaskOptIn on/off", "quota check enabled/disabled"),
  availability labels
- `HandoffsSurface.tsx` (14) — status (arguably semantic), `strategy`,
  lineage `kind`, "N children" count, per-check state badges
- `UsageSurface.tsx` (14), `ArtifactsSurface.tsx` (13),
  `CheckpointsSurface.tsx` (12), `SecretsSurface.tsx` (11),
  `ConversationsSurface.tsx` (10), `ControlsSurface.tsx` (10),
  `McpSurface.tsx` (9), `ProjectsSurface.tsx` (8), `SettingsModal.tsx`
  (7), `MachinesSurface.tsx` (4), plus smaller counts elsewhere

T3 reference (`apps/web/src/components/ui/badge.tsx` + call sites):
Badge marks *status/classification* — "Linked", "Credential rejected",
run status, "Default", environment identification pill, "Coming Soon".
Plain metadata renders as muted text; T3's badge call-site count is an
order of magnitude lower per surface.

**Root cause.** `badge.tsx` was vendored as a generic chip primitive and
surfaces reached for it as the default way to make any short value look
"structured". No rule or type distinguishes a semantic status badge
from a metadata chip; `text-2xs` muted metadata styling already exists
and is the correct vehicle for non-semantic values.

**Scope.** All surfaces and shell components. Legitimate badge use
(status, severity, classification that changes meaning or action) is
preserved — this is not a badge-count limit.

**Detection (partially landed).**

1. `StatusBadge` (`src/components/ui/status-badge.tsx`) is the typed
   status channel: `status: "ok" | "warning" | "error" | "neutral"`
   maps to the Badge variant union in one place.
2. `herdr-t3/no-raw-badge`
   (`lint-plugin/rules/no-raw-badge.ts`) flags raw `<Badge>` JSX. It is
   `error` everywhere except `src/components/**` (excluding `ui/` and
   tests), where it is `warn` — the ~149 surface call sites are
   migration debt owned by the #534 audit, and warn keeps the signal
   visible without failing `lint:ui` until each site is classified.
   `src/components/ui/**` is exempt (the primitives themselves).
3. Metadata values render via muted text (`text-sm
   text-muted-foreground` and the existing `text-2xs` metadata style);
   per-call-site classification is recorded in the #534 audit table.

Honest limit: whether a value is "meaning-bearing" is partially a
judgment call; the rule enforces the *channel* (status component vs raw
badge vs text) and the audit records each call site's classification.
Until the component-level warn debt is burned down, new raw `<Badge>`
inside `src/components/**` only warns — that gap is explicit, not
silent.

**Fixtures.** `scripts/lint-fixtures/bad.tsx` carries a raw
`<Badge variant="secondary">` metadata chip (asserted by
`scripts/lint-ui.test.ts`); `good.tsx` carries a `StatusBadge` positive
control.

**Fix delivered (shell scope).** `SettingsModal` migrated: four status
indicators (machine, bridge, herdr health, ghostty engine) now go
through `StatusBadge`; three metadata chips ("T3 Code", "Ghostty",
"MIT") render as muted text. `SidebarChrome`'s environment
identification pill keeps raw `Badge` with a reasoned suppression — it
is a persistent environment *classification*, matching T3's own
badge usage for environment identification.

**Status.** `open` — channel enforcement landed (StatusBadge + rule +
fixtures + shell migration); the `src/components/**` warn-level debt
(~149 sites) and per-call-site classification remain #534 audit work
before the rule can be promoted to `error` there.

**Unguaranteed.** Does not judge whether a retained status badge's
variant choice is the *right* semantic mapping; that stays with review
and the typed component's variant union.

## Adding cases

Append `AC-NNN` entries here in the same PR that lands the fix + gate
(§4–5 of the protocol). Cross-reference the implementing PR and any
fixture files (`scripts/lint-fixtures/`, UI scenario manifests). A case
moves to `verified` only when the real check has rejected the negative
fixture and accepted the positive control on the landing SHA.
