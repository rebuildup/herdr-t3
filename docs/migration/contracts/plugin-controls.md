# Contract: controls surface — command/wait/interrupt/start (B3)

Version: 1. Scope: consuming `herdr-plugins.controls/v1` through
`plugin_call` (ADR-0011 boundary, pinned at
`rebuildup/hoxay-plugins@d23205af0cd2ff7dba25f72e1f3b872762a108ee` =
tag `v0.9.0`). The plugin is the agent operation core — provider
slash-command passthrough, PTY-level interrupt, status wait, scrollback
read, rename, and agent launch with per-provider launch options — all
over herdr's `agent.*` socket API with a resolved-identity echo and
`--expect-*` generation guards. This client consumes a deliberate
subset (issue #450). Upstream spec:
`hoxay-plugins/docs/contracts/controls-v1.md` (**v1 stable** since
hoxay-plugins v0.6.0 / plugin v0.6.0).

## Boundary decision: what is NOT consumed and why

The bridge already exposes `agent.prompt` (PaneMessageDialog),
`agent.read` (pane diagnostics), and whitelists `agent.rename` /
`agent.start` RPCs, and `pane.send_keys` covers raw key injection. Per
the issue's no-reimplementation rule, this surface offers only the
plugin-contract capabilities herdr does not provide:

- `send` — **not consumed**: identical to the bridge's `agent.prompt`
  (same upstream call, same blocked-agent rejection). The plugin adds
  only the identity echo and `--expect-*` guards, which this client
  emits anyway on the commands it does call.
- `rename` — **not consumed**: `agent.rename` is a whitelisted bridge
  RPC; the plugin adds nothing contract-specific.
- `read` — **not consumed**: `agent.read` scrollback is already used by
  pane diagnostics; conversation history belongs to
  `herdr-plugins.conversations`.
- `--arg` / `--unsafe-args` on `start` — **not consumed**: raw provider
  argv passthrough (including the privilege-escalation opt-out) stays a
  plugin-CLI capability; the GUI exposes only the structured launch
  options the contract's per-provider table verifies.

Consumed commands (the local `CONTROLS_MUTATION_COMMANDS` allowlist is
exactly the mutation subset offered):

## Operations consumed

Commands are flat `plugin_call` command words; the plugin emits one
JSON document `{contract:"herdr-plugins.controls/v1", command, …}` on
stdout (`capability` emits the bare discovery document):

- `capability` → `{contract, plugin:"rebuildup.controls", version,
  read_only:false, mutation_commands:["send","command","interrupt",
  "rename","start"], commands:[…], operations:{api,pty_level,note},
  providers[]{id,launch{model,reasoning,permission_modes,resume},
  commands{known,fragile,verified,note}}, dialogs{}, upstream_gaps[],
  notes[]}`. This client requires `command`, `wait`, `interrupt`,
  `start` in `commands` (the consumed set); `send`/`rename`/`read` are
  recognized but never invoked.
- `command <target> <slash-command> [args...] [--wait] [--wait-until
  STATUS]... [--timeout-ms MS]` → provider slash-command passthrough via
  `agent.prompt` (bracketed paste + Enter). Result echoes
  `passthrough:"agent.prompt"`, `command_name`, submitted `text`,
  `provider{kind,commands,known_command,note}`, and `fragile:true` —
  all rendered verbatim; `known_command` is a hint, never a gate. The
  GUI normalizes the name to a leading `/` (contract regex
  `/[A-Za-z][A-Za-z0-9_-]*/`) and offers the provider's advisory
  `commands.known` table as clickable chips.
- `wait <target> [--until STATUS]... [--timeout-ms MS]` → `agent.wait`
  status observation. **Non-mutating** per the contract (absent from
  `mutation_commands`), so it needs no confirmation; `until` defaults
  upstream to `idle|done|blocked`.
- `interrupt <target> [--key KEY]...` → `agent.send_keys` **PTY-level
  key injection, not a structured interrupt**; result echoes
  `pty_level:true` and the GUI labels it as such. Empty keys emit no
  flags — the plugin default is `["esc"]`.
- `start <pane_id> --agent <kind> [--name] [--model] [--reasoning]
  [--permission-mode] [--resume V | --resume-from TARGET]
  [--timeout-ms] [--wait] [--wait-until STATUS]... [--wait-timeout-ms]`
  → `agent.start` launch in an existing shell pane plus the plugin's
  per-provider launch-option argv mapping. The GUI exposes the
  structured options only, gated per provider by
  `capability.providers[].launch` (`model`/`reasoning` booleans,
  `permission_modes` keys, `resume != "unsupported"`); unsupported
  options are hidden with the contract's own verdict, never defaulted.
  `--resume` and `--resume-from` are mutually exclusive (enforced
  client-side and upstream). `--timeout-ms` is emitted only inside the
  contract bounds `(3000, 300000]`.

## Identity guards

Every agent-target command accepts `--expect-pane`,
`--expect-state-seq`, `--expect-agent-session`; a mismatch aborts with
`kind:"stale_generation"` **before** the mutating `agent.*` call. The
GUI derives all three automatically from the live snapshot agent
record (`controlsExpectFromAgent`) — pane id always, `state_change_seq`
and `agent_session.value` when herdr reports them — so mutations are
generation-safe without user-typed guards. `start` takes a pane id, not
an agent target, so the guards do not apply (contract rule: no prior
generation to guard).

## Errors and freshness

- Boundary failures classify into the shared
  `not_installed|disabled|incompatible|unreachable|error` taxonomy;
  plugin-side `error.kind` values (`requires_interactive_input`,
  `stale_generation`, `agent_not_found`, `agent_blocked`, `timeout`,
  `unsupported_launch_option`, `unsafe_agent_argument`,
  `no_agent_session`, `resume_session_mismatch`, `usage`, …) stay
  `error` with verbatim detail — the bridge prefers `kind` over `code`
  as the error code. `session_unreachable` maps to `unreachable`
  (plugin could not reach the herdr session; same rule as
  conversations.ts).
- `refreshControls(machine)` mirrors the automations store: plugin
  discovery → enabled check → capability probe → `ready`. There is no
  eager data read — agents come from the live bridge snapshot and every
  operation is an explicit user action. Refreshed on snapshot pushes
  (debounced 800ms, capped at one probe per 15s per machine — the #422
  amplification guard), machine online transitions, and machine-list
  changes via `initControls()`.
- Mutation gating is three-way: the local
  `CONTROLS_MUTATION_COMMANDS` allowlist (`command`/`interrupt`/
  `start`), the advertised `mutation_commands`, and the flat
  `commands` list — `controlsSupportsMutation` fails closed on any
  miss. Every mutation runs through an explicit confirmation dialog;
  `blocked` agents show the `requires_interactive_input` warning before
  submit (the plugin rejects them upstream anyway — success is never
  fabricated).
