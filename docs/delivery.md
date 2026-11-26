# Delivery: release-driven integration paths

Operating model: `organization/profiles/release-driven-solo.md`.
Mechanical enforcement (issue #312, added after the PR #306 mis-merge):

## Enforced shapes

| PR shape | Allowed? | Mechanism |
|---|---|---|
| `release-* -> main` | yes — release PR | `integration-path` check passes; merge still requires **explicit user authorization** |
| `<ticket/feature> -> release-*` | yes — ticket PR | `integration-path` check passes; lands autonomously once quality gates pass |
| anything -> `main` with non-`release-*` head | **no** | `integration-path` fails; ruleset blocks merge |
| older `release-*` -> newer `release-*` | yes — release-train sync PR | `integration-path` passes only when the head version sorts before the base (numeric compare); propagates fixes forward across trains (issue #386) |
| newer/equal `release-* -> release-*` | **no** | `integration-path` fails |
| any other base branch | **no** | `integration-path` fails |

## Mechanism

- `.github/workflows/release-path.yml` runs the `integration-path` job on
  every `pull_request` and validates only the *shape* of the path
  (base/head branch names). It performs no code checks.
- Release-train sync (issue #386): `release-0-6-0 -> release-0-7-0`-style
  PRs are allowed so fixes on a converging train propagate to the next.
  The check compares the numeric version triple; only strictly-older ->
  strictly-newer passes. Ticket and release->main paths are unchanged.
- Repo ruleset `release-driven-paths` (id 28132948, active) applies to
  `refs/heads/main` and `refs/heads/release-*`:
  - requires a pull request, merge commits only
    (`allow_merge_commit`, no squash/rebase)
  - requires the `integration-path` status check to pass
  - requires zero approving reviews — deliberately unset so that
    `release-* -> main` keeps its human authorization boundary
    (ticket-merge authority never extends to release merges)

## Verified

- Probe PR #346 (`312-probe -> main`, ticket-shaped): `integration-path`
  failed in 3s and the ruleset reported the PR `BLOCKED`. Closed
  unmerged; this is the recorded fail-path evidence.
- All ticket PRs to `release-0-6-0` since show `integration-path` pass.

## Remaining human boundary

The ruleset enforces path *shape* only. It cannot judge whether a
`release-* -> main` merge is authorized — that remains an explicit
maintainer decision per the profile. Do not add required-review rules
to automate it.
