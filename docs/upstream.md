# Upstream baseline

The commits this repository's design and protocol work was verified against.
Update this table when a port re-baselines against a newer upstream.

| Project | Repository | Pinned commit | Used for |
| --- | --- | --- | --- |
| herdr | <https://github.com/herdrdev/herdr> | `e8d7d9705a7a2c89cef4dd42079379f05685af87` (v0.9.5+, 2026-11-20) | session/agent/tab/pane semantics, client-shell behavior (agent sidebar tokens, mouse/IME handling), JSON API schema |
| T3 Code | <https://github.com/pingdotgg/t3code> | `9cc4018c75ff4c61be8e86a6391d49a6c2d79830` | UI primitives, theme tokens, web UI rules (`docs/internals/web-ui.md`, `AGENTS.md`), sidebar settle/inbox model, motion tokens |
| Ovis | <https://github.com/devswha/ovis> | `e16802a2f37325f78400e2fc66f60db945686751` | herdr RPC/attach semantics, bridge traps, test-session discipline |
| ACP Registry | <https://github.com/agentclientprotocol/registry> | `b150ba592b85f8ee5f9f3457ce080197e3a1922e` | official agent brand icons vendored under `src/components/agent-icons/` |
| oh-my-pi | <https://github.com/can1357/oh-my-pi> | `2be354322dee0cdd95bc42fc61c72ef9767b653b` | OMP agent icon (`assets/icon.svg`) vendored under `src/components/agent-icons/` |
| Mastra | <https://github.com/mastra-ai/mastra> | `7707dd7fe9cdd24f693ceed7b9732e00365ea574` | Mastra Code agent icon (`LogoWithoutText`) vendored under `src/components/agent-icons/` |
| aude-skills | <https://github.com/rebuildup/aude-skills> | `2ac7951c01cdce3a59dade7eb6434e9b13382cb8` (`v0.14.1`; previous pin `285b139` was upstream `v0.13.0`) | release-driven operating model, Constitution, Skills |
| pc-setup | <https://github.com/rebuildup/pc-setup> | `afa06265d8e3404bdb9c2e30df5924765a81657f` | macOS / Windows install & verify integration |
| design-skills | <https://github.com/rebuildup/design-skills> | `5ca210a1b8a72ec3857a50caf7f25971b1b111b6` (`v0.7.1`; `skills/` content identical to evaluated `v0.7.0` `3d1480e7`) | design review & verification skills (`design-discipline`, `design-intent`, `composition-review`, `visual-review` trial) |
| dotfiles | <https://github.com/rebuildup/dotfiles> | `d1f7ffd7bdac65e924bb04d2ca60484f53860c27` | existing machine environment assumptions |

Licenses: T3 Code and Ovis are MIT; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
