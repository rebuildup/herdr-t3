# Upstream baseline

The commits this repository's design and protocol work was verified against.
Update this table when a port re-baselines against a newer upstream.

| Project | Repository | Pinned commit | Used for |
| --- | --- | --- | --- |
| T3 Code | <https://github.com/pingdotgg/t3code> | `9cc4018c75ff4c61be8e86a6391d49a6c2d79830` | UI primitives, theme tokens, web UI rules (`docs/internals/web-ui.md`, `AGENTS.md`) |
| Ovis | <https://github.com/devswha/ovis> | `e16802a2f37325f78400e2fc66f60db945686751` | herdr RPC/attach semantics, bridge traps, test-session discipline |
| project-init | <https://github.com/rebuildup/project-init> | `cf827d20dc8c0cb6026342c86acdd72a6672d360` | release-driven operating model, Constitution, Skills |
| pc-setup | <https://github.com/rebuildup/pc-setup> | `afa06265d8e3404bdb9c2e30df5924765a81657f` | macOS / Windows install & verify integration |
| design-skills | <https://github.com/rebuildup/design-skills> | `97deb07b16e1d404534e57ebdb95d14b4c068b9e` | design review & verification skills |
| dotfiles | <https://github.com/rebuildup/dotfiles> | `d1f7ffd7bdac65e924bb04d2ca60484f53860c27` | existing machine environment assumptions |

Licenses: T3 Code and Ovis are MIT; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
