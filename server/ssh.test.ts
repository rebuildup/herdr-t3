import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { remoteArgvCommand, sshPluginHost, type SshEndpoint } from "./ssh.ts";
import { OUTPUT_CAP } from "./plugins.ts";

const dirs: string[] = [];
const savedEnv = new Map<string, string | undefined>();

function fakeHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "ht3-ssh-"));
  dirs.push(dir);
  return dir;
}

function setEnv(key: string, value: string): void {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
  process.env[key] = value;
}

afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const POSIX: SshEndpoint = { id: "t1", target: "fake-host", session: "default", remoteHerdr: "/usr/bin/herdr" };
const WINDOWS: SshEndpoint = {
  id: "t2",
  target: "fake-win",
  session: "default",
  remoteHerdr: "C:\\herdr\\herdr.exe",
  os: "windows",
};

function decodePowerShell(cmd: string): string {
  const encoded = cmd.split("-EncodedCommand ")[1]!;
  return Buffer.from(encoded, "base64").toString("utf16le");
}

describe("remoteArgvCommand timeout bound (issue #537)", () => {
  test("posix payload becomes a watched background job with a process-group kill", () => {
    const cmd = remoteArgvCommand(POSIX, ["bun", "run", "src/cli.ts", "list"], "/plugins/inbox", [], {}, 15_000);
    const lines = cmd.split("\n");
    // The payload — scrub/env/cd prefix included — is backgrounded first.
    expect(lines[0]).toBe("cd '/plugins/inbox' && 'bun' 'run' 'src/cli.ts' 'list' &");
    expect(lines[1]).toBe("__ht3_pid=$!");
    // Watchdog bound: ceil(15000/1000) + 2 = 17s, safely past the local
    // 15s timer so `timedOut` semantics are preserved.
    expect(cmd).toContain("[ $__ht3_i -ge 17 ]");
    expect(cmd).toContain("kill -KILL -$__ht3_p");
    expect(cmd).toContain("wait $__ht3_pid");
    expect(cmd).toContain("exit $__ht3_rc");
    // The bound must sit *after* the payload launch.
    expect(cmd.indexOf("'list' &")).toBeLessThan(cmd.indexOf("__ht3_pid=$!"));
  });

  test("posix bound applies the scrub/env prefix inside the backgrounded payload", () => {
    const cmd = remoteArgvCommand(
      POSIX,
      ["herdr", "plugin", "list", "--json"],
      undefined,
      ["HERDR_PANE_ID"],
      { HERDR_SOCKET_PATH: "/r/herdr.sock" },
      5_000,
    );
    expect(cmd.startsWith("unset HERDR_PANE_ID; export HERDR_SOCKET_PATH='/r/herdr.sock'; 'herdr'")).toBe(true);
    expect(cmd).toContain("'herdr' 'plugin' 'list' '--json' &");
    expect(cmd).toContain("[ $__ht3_i -ge 7 ]");
  });

  test("posix without timeoutMs keeps the legacy unwrapped shape", () => {
    const cmd = remoteArgvCommand(POSIX, ["bun", "run", "x"], "/p");
    expect(cmd).toBe("cd '/p' && 'bun' 'run' 'x'");
  });

  test("windows payload runs under Start-Process with WaitForExit + taskkill", () => {
    const cmd = remoteArgvCommand(WINDOWS, ["C:\\plugins\\git\\bun.exe", "run", "src/cli.ts", "list"], "D:\\plugins\\git", [], {}, 15_000);
    const script = decodePowerShell(cmd);
    expect(script).toContain("Start-Process -FilePath 'C:\\plugins\\git\\bun.exe'");
    expect(script).toContain("-ArgumentList");
    // Local timeout 15000ms + 2000ms grace.
    expect(script).toContain("$p.WaitForExit(17000)");
    expect(script).toContain("taskkill.exe /PID $p.Id /T /F");
    expect(script).toContain("exit 124");
    expect(script).toContain("exit $p.ExitCode");
    expect(script).toContain("Set-Location -LiteralPath 'D:\\plugins\\git'");
  });

  test("windows without timeoutMs keeps the direct invocation shape", () => {
    const cmd = remoteArgvCommand(WINDOWS, ["herdr", "plugin", "list"], undefined, [], {}, undefined);
    const script = decodePowerShell(cmd);
    expect(script).toContain("& herdr plugin list; exit $LASTEXITCODE");
    expect(script).not.toContain("Start-Process");
  });
});

/* ------------------------------------------------------------------ */
/* sshPluginHost end-to-end through a fake `ssh` on PATH (POSIX only)   */
/* ------------------------------------------------------------------ */

const FAKE_SSH_TS = `
import { appendFileSync, writeSync } from "node:fs";
import { spawn } from "node:child_process";

// The remote command is ssh's last argv element.
const last = process.argv[process.argv.length - 1] ?? "";
const log = process.env["HT3_SSH_LOG"];
if (log) appendFileSync(log, last + "\\n");
const mode = process.env["HT3_SSH_MODE"] ?? "exec";
if (mode === "big") {
  // > OUTPUT_CAP of stdout, then exit — exercises the exec stdout cap.
  const chunk = Buffer.alloc(1024 * 1024, 0x61);
  for (let i = 0; i < 17; i++) writeSync(1, chunk);
  process.exit(0);
}
if (mode === "log") process.exit(0);
// Like a real sshd session: run the remote command in its own session
// (detached => own process group) so the remote watchdog's group kill
// cannot reach the test runner. stdio inherit proxies the ssh pipes.
const child = spawn("sh", ["-c", last], { detached: true, stdio: ["inherit", "inherit", "inherit"] });
child.on("error", () => process.exit(127));
child.on("exit", (code) => process.exit(code ?? 0));
`;

function installFakeSsh(dir: string): { logPath: string; markerPath: string } {
  const bun = process.execPath;
  const scriptPath = join(dir, "fake-ssh.ts");
  writeFileSync(scriptPath, FAKE_SSH_TS);
  const sshPath = join(dir, "ssh");
  writeFileSync(sshPath, `#!/bin/sh\nexec "${bun}" "${scriptPath}" "$@"\n`);
  chmodSync(sshPath, 0o755);
  const logPath = join(dir, "ssh.log");
  setEnv("PATH", `${dir}:${process.env["PATH"] ?? ""}`);
  setEnv("HT3_SSH_LOG", logPath);
  setEnv("HOME", dir);
  return { logPath, markerPath: join(dir, "marker") };
}

// These tests spawn real subprocess trees; remote bounds add seconds.
const posixOnly = process.platform !== "win32";

describe("sshPluginHost exec transport (issue #537)", () => {
  test("remote stdout is capped at OUTPUT_CAP like the local path", async () => {
    if (!posixOnly) return;
    const dir = fakeHome();
    installFakeSsh(dir);
    setEnv("HT3_SSH_MODE", "big");
    const host = sshPluginHost(POSIX, "default");
    const outcome = await host.exec(["true"], { timeoutMs: 10_000 });
    expect(outcome.timedOut).toBe(false);
    expect(outcome.code).toBe(0);
    // 17 MiB emitted; the tail-cap keeps exactly OUTPUT_CAP chars.
    expect(outcome.stdout.length).toBe(OUTPUT_CAP);
  }, 30_000);

  test("plugin exec argv reaches ssh wrapped in the remote timeout bound", async () => {
    if (!posixOnly) return;
    const dir = fakeHome();
    const { logPath } = installFakeSsh(dir);
    setEnv("HT3_SSH_MODE", "log");
    const host = sshPluginHost(POSIX, "default");
    await host.exec(["bun", "run", "src/cli.ts", "list"], {
      timeoutMs: 15_000,
      cwd: "/plugins/inbox",
      envRemove: ["HERDR_PANE_ID"],
      envSet: { HERDR_SOCKET_PATH: "/r/herdr.sock" },
    });
    const remote = readFileSync(logPath, "utf8");
    expect(remote).toContain("unset HERDR_PANE_ID; export HERDR_SOCKET_PATH='/r/herdr.sock'; cd '/plugins/inbox' && 'bun' 'run' 'src/cli.ts' 'list' &");
    expect(remote).toContain("__ht3_pid=$!");
    expect(remote).toContain("[ $__ht3_i -ge 17 ]");
    expect(remote).toContain("wait $__ht3_pid");
    expect(remote).toContain("exit $__ht3_rc");
  }, 30_000);

  test("remote command completes normally and propagates its exit code", async () => {
    if (!posixOnly) return;
    const dir = fakeHome();
    const { markerPath } = installFakeSsh(dir);
    const host = sshPluginHost(POSIX, "default");
    const outcome = await host.exec(
      ["sh", "-c", `sleep 1; touch '${markerPath}'`],
      { timeoutMs: 15_000 },
    );
    expect(outcome.timedOut).toBe(false);
    expect(outcome.code).toBe(0);
    expect(existsSync(markerPath)).toBe(true);
  }, 30_000);

  test("a timed-out remote command cannot outlive its bound (no orphan)", async () => {
    if (!posixOnly) return;
    const dir = fakeHome();
    const { markerPath } = installFakeSsh(dir);
    const host = sshPluginHost(POSIX, "default");
    // Local timeout 1s; remote bound = ceil(1)+2 = 3s (+~1s poll
    // granularity). The payload would touch the marker at 6s — only
    // reachable if the remote side were left running after the local
    // ssh kill, which is exactly the defect this fixes.
    const started = Date.now();
    const outcome = await host.exec(["sh", "-c", `sleep 6; touch '${markerPath}'`], {
      timeoutMs: 1_000,
    });
    expect(outcome.timedOut).toBe(true);
    // Wait until well past both the payload's 6s touch and the remote
    // watchdog's ~4s kill, then assert the marker never appeared.
    const wait = 7_500 - (Date.now() - started);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    expect(existsSync(markerPath)).toBe(false);
  }, 30_000);
});
