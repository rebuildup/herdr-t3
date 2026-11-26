import { describe, expect, test } from "bun:test";
import {
  assertBridgeTargetIsolated,
  defaultHerdrSocketPath,
  normalizeSocketPath,
  resolveVerifyTarget,
  sessionSocketPath,
  VerifyIsolationError,
} from "./verify-guard";

const UNIX_ENV = { HOME: "/home/tester", HERDR_SOCKET: undefined } as Record<
  string,
  string | undefined
>;

describe("sessionSocketPath", () => {
  test("named session maps under sessions/<name>", () => {
    expect(sessionSocketPath("ht3verify", UNIX_ENV, "linux")).toBe(
      "/home/tester/.config/herdr/sessions/ht3verify/herdr.sock",
    );
  });
  test("default session resolves to the live socket", () => {
    expect(sessionSocketPath("default", UNIX_ENV, "linux")).toBe(
      "/home/tester/.config/herdr/herdr.sock",
    );
    expect(sessionSocketPath("", UNIX_ENV, "linux")).toBe(
      "/home/tester/.config/herdr/herdr.sock",
    );
  });
  test("windows layout uses APPDATA", () => {
    const env = { APPDATA: "C:\\Users\\t\\AppData\\Roaming" };
    // join() emits the host separator; compare normalized forms.
    expect(normalizeSocketPath(sessionSocketPath("ht3x", env, "win32"), env)).toBe(
      normalizeSocketPath("C:\\Users\\t\\AppData\\Roaming\\herdr\\sessions\\ht3x\\herdr.sock", env),
    );
    expect(normalizeSocketPath(defaultHerdrSocketPath(env, "win32"), env)).toBe(
      normalizeSocketPath("C:\\Users\\t\\AppData\\Roaming\\herdr\\herdr.sock", env),
    );
  });
});

describe("normalizeSocketPath", () => {
  test("expands ~ and strips the windows pipe prefix", () => {
    expect(normalizeSocketPath("~/.config/herdr/herdr.sock", UNIX_ENV)).toBe(
      "/home/tester/.config/herdr/herdr.sock",
    );
    expect(normalizeSocketPath("\\\\.\\pipe\\C:\\h\\herdr.sock", {})).toBe("C:\\h\\herdr.sock");
  });
});

describe("resolveVerifyTarget", () => {
  test("refuses when no explicit target is given", () => {
    expect(() => resolveVerifyTarget({ argv: [], env: UNIX_ENV, platform: "linux" })).toThrow(
      VerifyIsolationError,
    );
  });
  test("refuses the default session", () => {
    expect(() =>
      resolveVerifyTarget({ argv: ["--session", "default"], env: UNIX_ENV, platform: "linux" }),
    ).toThrow(/live herdr session/);
  });
  test("refuses HERDR_SOCKET pointed at the live socket", () => {
    expect(() =>
      resolveVerifyTarget({
        argv: [],
        env: { ...UNIX_ENV, HERDR_SOCKET: "/home/tester/.config/herdr/herdr.sock" },
        platform: "linux",
      }),
    ).toThrow(/live herdr session/);
  });
  test("accepts a named isolated session", () => {
    const target = resolveVerifyTarget({
      argv: ["--session", "ht3draft"],
      env: UNIX_ENV,
      platform: "linux",
    });
    expect(target.session).toBe("ht3draft");
    expect(target.resolvedSocket).toBe(
      "/home/tester/.config/herdr/sessions/ht3draft/herdr.sock",
    );
  });
  test("accepts HERDR_VERIFY_SESSION env", () => {
    const target = resolveVerifyTarget({
      argv: [],
      env: { ...UNIX_ENV, HERDR_VERIFY_SESSION: "ht3probe" },
      platform: "linux",
    });
    expect(target.session).toBe("ht3probe");
  });
  test("accepts an explicit non-default HERDR_SOCKET", () => {
    const target = resolveVerifyTarget({
      argv: [],
      env: { ...UNIX_ENV, HERDR_SOCKET: "/tmp/isolated/herdr.sock" },
      platform: "linux",
    });
    expect(target.socketPath).toBe("/tmp/isolated/herdr.sock");
    expect(target.resolvedSocket).toBe("/tmp/isolated/herdr.sock");
  });
  test("CLI --session beats env", () => {
    const target = resolveVerifyTarget({
      argv: ["--session=ht3cli"],
      env: { ...UNIX_ENV, HERDR_VERIFY_SESSION: "ht3env" },
      platform: "linux",
    });
    expect(target.session).toBe("ht3cli");
  });
});

describe("assertBridgeTargetIsolated", () => {
  const isolatedSocket = "/home/tester/.config/herdr/sessions/ht3draft/herdr.sock";
  const healthOk = (socket: string) =>
    new Response(JSON.stringify({ herdr: { reachable: true, socket } }), {
      status: 200,
    });

  test("passes when the bridge reports the declared isolated socket", async () => {
    const target = await assertBridgeTargetIsolated("http://localhost:5799/", {
      argv: ["--session", "ht3draft"],
      env: UNIX_ENV,
      platform: "linux",
      fetchImpl: (async () => healthOk(isolatedSocket)) as typeof fetch,
    });
    expect(target.session).toBe("ht3draft");
  });
  test("refuses when the bridge is bound to the live session", async () => {
    await expect(
      assertBridgeTargetIsolated("http://localhost:5799/", {
        argv: ["--session", "ht3draft"],
        env: UNIX_ENV,
        platform: "linux",
        fetchImpl: (async () =>
          healthOk("/home/tester/.config/herdr/herdr.sock")) as typeof fetch,
      }),
    ).rejects.toThrow(/live herdr session/);
  });
  test("refuses when script env and server env disagree", async () => {
    await expect(
      assertBridgeTargetIsolated("http://localhost:5799/", {
        argv: ["--session", "ht3draft"],
        env: UNIX_ENV,
        platform: "linux",
        fetchImpl: (async () =>
          healthOk("/home/tester/.config/herdr/sessions/ht3other/herdr.sock")) as typeof fetch,
      }),
    ).rejects.toThrow(/target mismatch/);
  });
  test("refuses when health is unreachable", async () => {
    await expect(
      assertBridgeTargetIsolated("http://localhost:1/", {
        argv: ["--session", "ht3draft"],
        env: UNIX_ENV,
        platform: "linux",
        fetchImpl: (async () => {
          throw new Error("connection refused");
        }) as typeof fetch,
      }),
    ).rejects.toThrow(/cannot verify bridge target isolation/);
  });
});
