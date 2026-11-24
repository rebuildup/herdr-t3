# Upstream baseline

The commits this repository's design and protocol work was verified against.
Update this table when a port re-baselines against a newer upstream.

| Project | Repository | Pinned commit | Used for |
| --- | --- | --- | --- |
| herdr | <https://github.com/herdrdev/herdr> | `e8d7d9705a7a2c89cef4dd42079379f05685af87` (v0.9.5+, 2026-11-20) | session/agent/tab/pane semantics, client-shell behavior (agent sidebar tokens, mouse/IME handling), JSON API schema |
| T3 Code | <https://github.com/pingdotgg/t3code> | `9cc4018c75ff4c61be8e86a6391d49a6c2d79830` | UI primitives, theme tokens, web UI rules (`docs/internals/web-ui.md`, `AGENTS.md`), sidebar settle/inbox model, motion tokens |
| Ovis | <https://github.com/devswha/ovis> | `e16802a2f37325f78400e2fc66f60db945686751` | herdr RPC/attach semantics, bridge traps, test-session discipline |
| project-init | <https://github.com/rebuildup/project-init> | `285b139b01c199d3d4135d90f3cc3f6a932eff3b` (v0.5.0 kickoff `main` HEAD; previous pin `cf827d2` is an ancestor) | release-driven operating model, Constitution, Skills |
| pc-setup | <https://github.com/rebuildup/pc-setup> | `afa06265d8e3404bdb9c2e30df5924765a81657f` | macOS / Windows install & verify integration |
| design-skills | <https://github.com/rebuildup/design-skills> | `97deb07b16e1d404534e57ebdb95d14b4c068b9e` | design review & verification skills |
| dotfiles | <https://github.com/rebuildup/dotfiles> | `d1f7ffd7bdac65e924bb04d2ca60484f53860c27` | existing machine environment assumptions |

Licenses: T3 Code and Ovis are MIT; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
