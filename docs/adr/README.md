# ADR index

| ADR | Status | Title |
| --- | --- | --- |
| [ADR-0001](./ADR-0001.md) | Accepted | Product identity and upstream baseline |
| [ADR-0002](./ADR-0002.md) | Accepted | Architecture: dedicated herdr bridge + T3 design system |
| [ADR-0003](./ADR-0003.md) | Accepted | UI stack and T3 port policy |
| [ADR-0004](./ADR-0004.md) | Superseded by ADR-0005 | Distribution: browser/PWA via pc-setup, no desktop shell |
| [ADR-0005](./ADR-0005.md) | Accepted | Distribution: native Electron desktop app |
| [ADR-0006](./ADR-0006.md) | Accepted | Remote machines: saved SSH endpoints over herdr's own bridges |
| [ADR-0007](./ADR-0007.md) | Accepted | Terminal: libghostty-vt engine replaces xterm.js |
| [ADR-0008](./ADR-0008.md) | Accepted | Canonical UI architecture: T3 Code application shell |
| [ADR-0009](./ADR-0009.md) | Accepted | T3 Code feature-parity program (v0.6.0+); AGENTS.md §5 amendment |
| [ADR-0010](./ADR-0010.md) | Accepted | Pane size authority stays with herdr; attach does not negotiate size |
| [ADR-0011](./ADR-0011.md) | Accepted | herdr-plugins contract consumption boundary; organize-state ownership and #173 migration |
| [ADR-0012](./ADR-0012.md) | Accepted | Source Control surface: git-v1 contract pin @62309b9c and per-host capability gating |
| [ADR-0013](./ADR-0013.md) | Accepted | GPUI staged migration: contract-first foundation and Electron removal gates |
| [ADR-0014](./ADR-0014.md) | Accepted | Projects/Scripts surface: projects-v1 contract pin @c8460283 and scope (auto triggers upstream-gated) |
| [ADR-0015](./ADR-0015.md) | Accepted | Projects/Scripts: projects-v1 schema v2 re-pin @b0c8c60 (run ownership + stop confirmation) |
| [ADR-0016](./ADR-0016.md) | Accepted | Checkpoints surface: checkpoints-v1 contract pin @4aab1a7 and scope (restore/auto-capture/GC upstream-gated) |
| [ADR-0017](./ADR-0017.md) | Accepted | Checkpoints: checkpoints-v1 re-pin @c8dc3b3 and plan/restore adoption (shared-worktree isolation, pre-restore recovery) |
| [ADR-0018](./ADR-0018.md) | Accepted | Source Control surface: git-v1 re-pin @d057830 (strict option parsing, usage exit 2) |
| [ADR-0019](./ADR-0019.md) | Accepted | Projects/Scripts: projects-v1 re-pin @3b28349 (durable script completion receipt) |
| [ADR-0020](./ADR-0020.md) | Accepted | Projects/Scripts: projects-v1 re-pin @2dcb2abf (shell families + audit convergence) |
| [ADR-0021](./ADR-0021.md) | Accepted | Checkpoints: checkpoints-v1 re-pin @55df8d0a and work-unit auto-capture adoption (kind/auto_captures/--auto) |
| [ADR-0022](./ADR-0022.md) | Accepted | plugin exec env scrub: no ambient herdr targeting vars on any exec path |
| [ADR-0023](./ADR-0023.md) | Accepted | plugin exec env scrub: no ambient GIT_* repo/config/transport targeting vars |
| [ADR-0024](./ADR-0024.md) | Accepted | Checkpoints: checkpoints-v1 re-pin @ae4f214 and save/restore-group/gc/prune adoption (partial-report bridge convention) |
| [ADR-0025](./ADR-0025.md) | Accepted | Transitional Rust consumer: wasm-in-runtime for small-data capabilities; no transitional consumer for per-frame paths |
| [ADR-0026](./ADR-0026.md) | Accepted | Automations surface: automations-v1 contract pin @6c1cfa5 and read-only adoption |
| [ADR-0027](./ADR-0027.md) | Accepted | Conversations surface: conversations-v1 contract pin @d23205af and read + index adoption |
| [ADR-0028](./ADR-0028.md) | Accepted | Usage surface: usage-v1 contract pin @d23205af and read-only adoption |
| [ADR-0029](./ADR-0029.md) | Accepted | Artifacts surface: artifacts-v1 contract pin @d23205af and read-surface adoption |
| [ADR-0030](./ADR-0030.md) | Accepted | Handoffs surface: handoff-v1 contract pin @d23205af and read-only adoption (mutations incl. top-level commands gated off) |
| [ADR-0031](./ADR-0031.md) | Accepted | TextGen surface: textgen-v1 contract pin @d23205af and read-surface adoption |
