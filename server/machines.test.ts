import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { endpointsPath, loadMachineMetadata, loadSavedMachines } from "./machines.ts";
import { isClientFrame } from "../shared/protocol.ts";
import { classifySshFailure, remoteArgvCommand, remoteBridgeCommand, sshArgs, sshPluginHost } from "./ssh.ts";
import { PLUGIN_ENV_SCRUB } from "./plugins.ts";

const dirs: string[] = [];
function fakeHome(): Record<string, string | undefined> {
  const dir = mkdtempSync(join(tmpdir(), "ht3-machines-"));
  dirs.push(dir);
  return { HOME: dir };
}
function writeEndpoints(env: Record<string, string | undefined>, body: unknown) {
  const dir = join(env["HOME"]!, ".local", "state", "herdr", "client");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "endpoints.json"), JSON.stringify(body));
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("loadSavedMachines", () => {
  test("parses herdr endpoints.json", () => {
    const env = fakeHome();
    writeEndpoints(env, {
      version: 1,
      ssh: [
        { id: "abc", label: "WSL", target: "device-wsl", session: "default", enabled: true },
        { id: "def", target: "device-win", session: "work", enabled: false },
        { id: "bad" },
        "junk",
      ],
    });
    const machines = loadSavedMachines(env);
    expect(machines).toHaveLength(2);
    expect(machines[0]).toMatchObject({ id: "abc", label: "WSL", target: "device-wsl", session: "default", enabled: true });
    expect(machines[1]).toMatchObject({ id: "def", label: "device-win", session: "work", enabled: false });
    expect(endpointsPath(env)).toContain("endpoints.json");
  });

  test("returns [] for missing or malformed registry", () => {
    expect(loadSavedMachines(fakeHome())).toEqual([]);
    const env = fakeHome();
    writeEndpoints(env, { ssh: "not-an-array" });
    expect(loadSavedMachines(env)).toEqual([]);
  });
});

describe("loadMachineMetadata", () => {
  test("reads cached os/executable", () => {
    const env = fakeHome();
    const dir = join(env["HOME"]!, ".local", "state", "herdr", "client", "ssh-metadata");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "abc.json"), JSON.stringify({ metadata: { os: "windows", executable: "C:\\herdr.exe" } }));
    expect(loadMachineMetadata("abc", env)).toEqual({ os: "windows", executable: "C:\\herdr.exe" });
    expect(loadMachineMetadata("missing", env)).toBeNull();
  });
});

describe("sshArgs", () => {
  test("never prompts, multiplexes, and ends with the target", () => {
    const args = sshArgs({
      id: "m1",
      target: "device-wsl",
      session: "default",
      remoteHerdr: "/home/u/.local/bin/herdr",
    });
    expect(args).toContain("BatchMode=yes");
    expect(args).toContain("ControlMaster=auto");
    expect(args[args.length - 1]).toBe("device-wsl");
    const cmd = remoteBridgeCommand(
      { id: "m1", target: "device-wsl", session: "default", remoteHerdr: "/home/u/.local/bin/herdr" },
      "remote-api-bridge",
    );
    expect(cmd).toContain("remote-api-bridge");
    expect(cmd).toContain("--session 'default'");
  });
});

describe("classifySshFailure", () => {
  test("maps ssh diagnostics to statuses", () => {
    expect(classifySshFailure("Permission denied (publickey).").kind).toBe("auth_required");
    expect(classifySshFailure("Host key verification failed.").kind).toBe("auth_required");
    expect(classifySshFailure("Connection timed out").kind).toBe("unreachable");
    expect(classifySshFailure("No route to host").kind).toBe("unreachable");
    expect(classifySshFailure("herdr: command not found").kind).toBe("error");
    expect(classifySshFailure("windows_remote_unsupported").kind).toBe("incompatible");
    expect(classifySshFailure("something else").kind).toBe("error");
  });
});

describe("isClientFrame machine fields", () => {
  test("accepts machine-tagged frames", () => {
    expect(isClientFrame({ type: "rpc", id: "1", method: "session.snapshot", machine: "abc" })).toBe(true);
    expect(isClientFrame({ type: "terminal_input", paneId: "p1", data: "x", machine: "abc" })).toBe(true);
    expect(isClientFrame({ type: "subscribe_terminal", paneId: "p1", machine: "abc" })).toBe(true);
  });

  test("rejects malformed machine ids and add targets", () => {
    expect(isClientFrame({ type: "rpc", id: "1", method: "session.snapshot", machine: "" })).toBe(false);
    expect(isClientFrame({ type: "rpc", id: "1", method: "session.snapshot", machine: 5 })).toBe(false);
    expect(isClientFrame({ type: "machine_add", id: "1", label: "x", target: "-oProxyCommand=evil" })).toBe(false);
    expect(isClientFrame({ type: "machine_add", id: "1", label: "x", target: "host", session: "s".repeat(65) })).toBe(false);
    expect(isClientFrame({ type: "machine_connect", machine: "m1" })).toBe(true);
  });
});

describe("windows remote bridge commands", () => {
  const winEndpoint = {
    id: "w1",
    target: "device-windows",
    session: "default",
    remoteHerdr: "C:\\Users\\u\\AppData\\Local\\herdr.exe",
    os: "windows",
  };

  test("api bridge emits an encoded powershell command with the ready marker", () => {
    const cmd = remoteBridgeCommand(winEndpoint, "remote-api-bridge");
    expect(cmd).toContain("powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand");
    const encoded = cmd.split("-EncodedCommand ")[1]!;
    const script = Buffer.from(encoded, "base64").toString("utf16le");
    expect(script).toContain("herdr-remote-output-ready:1");
    expect(script).toContain("remote-api-bridge --check");
    expect(script).toContain("herdr-api-bridge-v1");
    expect(script).toContain("herdr-machine-metadata-stale-v1");
    expect(script).toContain("Start-Process");
  });

  test("client bridge streams remote-client-bridge", () => {
    const cmd = remoteBridgeCommand(winEndpoint, "remote-client-bridge");
    const encoded = cmd.split("-EncodedCommand ")[1]!;
    const script = Buffer.from(encoded, "base64").toString("utf16le");
    expect(script).toContain("remote-client-bridge");
    expect(script).not.toContain("--check");
  });

  test("posix endpoint keeps the shell-quoted form", () => {
    const cmd = remoteBridgeCommand(
      { id: "p", target: "h", session: "s1", remoteHerdr: "/home/u/herdr" },
      "remote-api-bridge",
    );
    expect(cmd).toBe("'/home/u/herdr' --session 's1' remote-api-bridge");
  });
});

describe("isClientFrame takeover", () => {
  test("accepts optional takeover boolean only", () => {
    expect(isClientFrame({ type: "subscribe_terminal", paneId: "p", takeover: true })).toBe(true);
    expect(isClientFrame({ type: "subscribe_terminal", paneId: "p", takeover: "yes" })).toBe(false);
  });
});

describe("remoteArgvCommand env scrubbing (issues #228/#270)", () => {
  const posix = { id: "p", target: "h", session: "s1", remoteHerdr: "/usr/bin/herdr" };
  const win = { id: "w", target: "h", session: "s1", remoteHerdr: "C:\\herdr.exe", os: "windows" };
  const scrub = ["HERDR_PANE_ID", "HERDR_PLUGIN_CONTEXT_JSON"];

  test("posix endpoint unsets each removed variable (no env -u, no blank-set)", () => {
    const cmd = remoteArgvCommand(posix, ["bun", "run", "src/cli.ts", "stage", "w1:p1"], "/plugins/git", scrub);
    // `unset` removes the variable; `VAR=''` would still count as set for
    // presence-checking consumers (the herdr CLI treats an empty
    // HERDR_SOCKET_PATH as an explicit override).
    expect(cmd).toBe(
      "unset HERDR_PANE_ID HERDR_PLUGIN_CONTEXT_JSON; cd '/plugins/git' && 'bun' 'run' 'src/cli.ts' 'stage' 'w1:p1'",
    );
  });

  test("posix endpoint unsets every plugin-boundary targeting var", () => {
    const cmd = remoteArgvCommand(
      posix,
      ["herdr", "plugin", "list", "--json"],
      undefined,
      PLUGIN_ENV_SCRUB,
    );
    expect(cmd.startsWith(`unset ${PLUGIN_ENV_SCRUB.join(" ")}; `)).toBe(true);
    for (const name of [
      "HERDR_SOCKET_PATH",
      "HERDR_CLIENT_SOCKET_PATH",
      "HERDR_SESSION",
      "HERDR_PANE_ID",
      "HERDR_WORKSPACE_ID",
      "HERDR_TAB_ID",
      "HERDR_PLUGIN_CONTEXT_JSON",
      "HERDR_PLUGIN_STATE_DIR",
      // GIT_* repo/config/transport targeting (issue #280, ADR-0023).
      "GIT_DIR",
      "GIT_WORK_TREE",
      "GIT_INDEX_FILE",
      "GIT_OBJECT_DIRECTORY",
      "GIT_CONFIG_PARAMETERS",
      "GIT_CONFIG_COUNT",
      "GIT_SSH_COMMAND",
      "GIT_EXEC_PATH",
    ]) {
      expect(cmd).toContain(name);
    }
    expect(cmd).toContain("'herdr' 'plugin' 'list' '--json'");
    // unset runs before the command, never as a per-command env prefix.
    expect(cmd).not.toContain("HERDR_SOCKET_PATH=''");
  });

  test("posix endpoint without envRemove is unchanged", () => {
    const cmd = remoteArgvCommand(posix, ["bun", "run", "x"], "/p");
    expect(cmd).toBe("cd '/p' && 'bun' 'run' 'x'");
  });

  test("invalid env names are not interpolated into the remote command", () => {
    const cmd = remoteArgvCommand(posix, ["true"], undefined, ["A; rm -rf /", "OK_NAME"]);
    expect(cmd).toBe("unset OK_NAME; 'true'");
  });

  test("windows endpoint clears the variables inside the PowerShell script", () => {
    const cmd = remoteArgvCommand(win, ["bun", "run", "src/cli.ts", "push", "w1:p1"], "C:\\plugins\\git", scrub);
    const encoded = cmd.split("-EncodedCommand ")[1]!;
    const script = Buffer.from(encoded, "base64").toString("utf16le");
    expect(script).toContain("$env:HERDR_PANE_ID=$null;");
    expect(script).toContain("$env:HERDR_PLUGIN_CONTEXT_JSON=$null;");
    expect(script).toContain("Set-Location -LiteralPath 'C:\\plugins\\git'");
    // The scrub must run before the command invocation.
    expect(script.indexOf("$env:HERDR_PANE_ID=$null;")).toBeLessThan(script.indexOf("& bun"));
  });

  test("windows endpoint scrubs every plugin-boundary targeting var", () => {
    const cmd = remoteArgvCommand(win, ["bun", "run", "src/cli.ts", "list"], "C:\\plugins\\inbox", PLUGIN_ENV_SCRUB);
    const encoded = cmd.split("-EncodedCommand ")[1]!;
    const script = Buffer.from(encoded, "base64").toString("utf16le");
    for (const name of PLUGIN_ENV_SCRUB) {
      expect(script).toContain(`$env:${name}=$null;`);
    }
    // $env:X=$null deletes the variable (not an empty-string set), and
    // every scrub token precedes the invocation.
    const firstScrub = script.indexOf("$env:HERDR_SOCKET_PATH=$null;");
    expect(firstScrub).toBeGreaterThanOrEqual(0);
    expect(firstScrub).toBeLessThan(script.indexOf("& bun"));
  });

  test("posix envSet re-pins a variable after the scrub (issue #289)", () => {
    const cmd = remoteArgvCommand(
      posix,
      ["herdr", "plugin", "list", "--json"],
      undefined,
      PLUGIN_ENV_SCRUB,
      { HERDR_SOCKET_PATH: "/remote/sessions/work/herdr.sock" },
    );
    expect(cmd).toContain("unset HERDR_SOCKET_PATH");
    expect(cmd).toContain("export HERDR_SOCKET_PATH='/remote/sessions/work/herdr.sock';");
    // envSet runs after unset and before the command.
    expect(cmd.indexOf("export HERDR_SOCKET_PATH")).toBeGreaterThan(cmd.indexOf("unset "));
    expect(cmd.indexOf("export HERDR_SOCKET_PATH")).toBeLessThan(cmd.indexOf("'herdr'"));
  });

  test("windows envSet assigns inside the PowerShell script", () => {
    const cmd = remoteArgvCommand(
      win,
      ["herdr", "plugin", "list", "--json"],
      undefined,
      PLUGIN_ENV_SCRUB,
      { HERDR_SOCKET_PATH: "C:\\herdr\\herdr.sock" },
    );
    const encoded = cmd.split("-EncodedCommand ")[1]!;
    const script = Buffer.from(encoded, "base64").toString("utf16le");
    expect(script).toContain("$env:HERDR_SOCKET_PATH=$null;");
    expect(script).toContain("$env:HERDR_SOCKET_PATH='C:\\herdr\\herdr.sock';");
    expect(script.indexOf("$env:HERDR_SOCKET_PATH='C:")).toBeLessThan(script.indexOf("& herdr"));
  });
});

describe("sshPluginHost session targeting (issue #289)", () => {
  const endpoint = { id: "m", target: "h", session: "work", remoteHerdr: "/usr/bin/herdr" };

  test("named session reaches plugin CLIs and herdr discovery argv", () => {
    const host = sshPluginHost(endpoint, "work");
    expect(host.pluginSession).toBe("work");
    expect(host.pluginSocket).toBeUndefined();
    // Discovery (`herdr plugin list`) must target the same named session —
    // without --session it would read the remote default session.
    expect(host.herdrArgv).toEqual(["/usr/bin/herdr", "--session", "work"]);
  });

  test("default session adds no targeting flags", () => {
    const host = sshPluginHost({ ...endpoint, session: "default" }, "default");
    expect(host.pluginSession).toBeUndefined();
    expect(host.herdrArgv).toEqual(["/usr/bin/herdr"]);
  });
});
