#!/usr/bin/env python3
"""Derive the canonical herdr TUI baseline from the installed herdr binary.

Issue #640 (herdr TUI ⇄ hoxay comparison). The baseline must be
*re-derivable*, not hand-written: every fact below comes from the
installed herdr binary, so the comparison can be re-run against any
herdr version and the diff between baselines is meaningful.

Usage:
    python3 quality/tui-parity/tui/derive_inventory.py [--herdr-bin herdr] [--out PATH]

Outputs (default: next to this script):
    inventory.json   the machine-readable baseline
"""
import argparse
import json
import pathlib
import re
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent


def run(binary: str, *args: str) -> str:
    proc = subprocess.run([binary, *args], capture_output=True, text=True)
    if proc.returncode != 0:
        raise SystemExit(f"herdr {' '.join(args)} failed: {proc.stderr.strip()}")
    return proc.stdout


def keybindings(config_text: str) -> dict:
    """Parse the [keys] table of herdr --default-config."""
    section = None
    raw = {}
    for line in config_text.splitlines():
        stripped = line.strip()
        bare = stripped.lstrip("#").strip()
        m_sec = re.match(r"^\[\[?([^\]]+)\]?\]$", bare)
        if m_sec:
            section = m_sec.group(1)
            continue
        m = re.match(r'^#\s*([a-z_][a-z0-9_]*)\s*=\s*"([^"]*)"\s*(#.*)?$', line)
        if not m or section != "keys":
            continue
        raw[m.group(1)] = m.group(2)
    return raw


def parse_modes(raw: dict) -> dict:
    prefix_default = raw.pop("prefix", "ctrl+b")
    prefix, navigate, resize, unset = {}, {}, {}, set()
    for key, value in raw.items():
        if key.startswith("navigate_"):
            navigate[key] = value
        elif key.startswith("resize_pane_"):
            resize[key] = value
        elif value == "":
            unset.add(key)
        else:
            prefix[key] = value
    return {
        "prefix": {
            "enter_key": prefix_default,
            "exit_key": "esc",
            "bindings": prefix,
            "documented_but_unset_by_default": sorted(unset),
        },
        "navigate": {
            "bindings": navigate,
            "note": "local shortcuts win while navigate mode is open; left/right arrows always focus the adjacent pane",
        },
        "resize": {
            "direct_bindings": resize,
            "note": "prefix+r enters resize mode; the four resize_pane_* bindings are optional and unset by default",
        },
        "copy_mode": {
            "default_binding": "prefix+e (edit_scrollback)",
            "note": "the binary keybind action enum also contains 'copy_mode'",
        },
        "overlay": {
            "note": "popup/help/settings overlays are opened via prefix-mode actions (help=prefix+?, settings=prefix+s)",
        },
    }


def rpc_methods(schema: dict) -> list:
    methods = []
    for variant in schema["schemas"]["request"]["oneOf"]:
        const = variant.get("properties", {}).get("method", {}).get("const")
        if const:
            methods.append(const)
    return sorted(methods)


def cli_groups(binary: str, groups: list) -> dict:
    groups_out = {}
    for group in groups:
        try:
            text = run(binary, group, "--help")
        except SystemExit:
            continue
        subs = []
        for line in text.splitlines():
            m = re.match(r"^  ([a-z][a-z0-9-]*)\s{2,}", line)
            if m:
                subs.append(m.group(1))
        groups_out[group] = sorted(set(subs))
    return groups_out


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--herdr-bin", default="herdr")
    parser.add_argument("--out", default=str(HERE / "inventory.json"))
    args = parser.parse_args()

    version = run(args.herdr_bin, "--version").strip()
    config_text = run(args.herdr_bin, "--default-config")
    schema = json.loads(run(args.herdr_bin, "api", "schema", "--json"))
    completion = run(args.herdr_bin, "completion", "zsh")

    modes = parse_modes(keybindings(config_text))
    methods = rpc_methods(schema)
    groups = cli_groups(
        args.herdr_bin,
        ["server", "machine", "session", "workspace", "worktree", "tab", "notification",
         "agent", "pane", "integration", "config", "channel", "completion", "api",
         "plugin", "terminal", "status", "update"],
    )
    hidden = sorted(set(re.findall(r"_herdr__subcmd__([a-z]+)_commands", completion)))
    hidden = [h for h in hidden if h not in groups]

    by_group = {}
    for method in methods:
        by_group.setdefault(method.split(".")[0], []).append(method)

    inventory = {
        "derived_from": {
            "herdr_bin": args.herdr_bin,
            "herdr_version": version,
            "commands": [
                "herdr --version",
                "herdr --default-config",
                "herdr api schema --json",
                "herdr completion zsh",
                "herdr <group> --help (for every CLI group)",
            ],
        },
        "modes": modes,
        "protocol": {
            "protocol": schema.get("protocol"),
            "schema_version": schema.get("schema_version"),
        },
        "rpc_methods": methods,
        "rpc_method_count": len(methods),
        "rpc_methods_by_group": {k: sorted(v) for k, v in sorted(by_group.items())},
        "cli_groups": groups,
        "cli_groups_hidden_from_help": hidden,
        "socket_and_session": {
            "default_session_socket": "~/.config/herdr/herdr.sock",
            "named_session_socket": "~/.config/herdr/sessions/<name>/herdr.sock",
            "config_path": "~/.config/herdr/config.toml",
            "env_overrides": ["HERDR_CONFIG_PATH", "HERDR_SOCKET_PATH", "HERDR_SESSION"],
        },
    }

    pathlib.Path(args.out).write_text(json.dumps(inventory, indent=2, ensure_ascii=False) + "\n")
    print(
        f"inventory written: {args.out} "
        f"(herdr {version}, {len(methods)} rpc methods, "
        f"{len(modes['prefix']['bindings'])} prefix bindings, {len(groups)} cli groups)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
