import { describe, expect, test } from "bun:test";
import {
  pluginBoundaryReason,
  pluginErrorCode,
  pluginErrorDetail,
  pluginErrorFields,
} from "./pluginErrors";

describe("pluginBoundaryReason (issue #538)", () => {
  test("maps the full bridge boundary vocabulary consistently", () => {
    expect(pluginBoundaryReason("plugin_not_installed")).toBe("not_installed");
    expect(pluginBoundaryReason("plugin_disabled")).toBe("disabled");
    for (const code of [
      "plugin_incompatible",
      "plugin_unsupported_command",
      "plugin_bad_output",
    ]) {
      expect(pluginBoundaryReason(code)).toBe("incompatible");
    }
    for (const code of [
      "plugin_host_unreachable",
      "plugin_timeout",
      "plugin_exec_failed",
      "machine_unavailable",
      "connect_failed",
      "unreachable",
    ]) {
      expect(pluginBoundaryReason(code)).toBe("unreachable");
    }
  });

  test("plugin_timeout and plugin_exec_failed are boundary, never domain errors", () => {
    // These previously fell through to git_error / plugin_error / error
    // depending on the surface (issue #538).
    expect(pluginBoundaryReason("plugin_timeout")).toBe("unreachable");
    expect(pluginBoundaryReason("plugin_exec_failed")).toBe("unreachable");
  });

  test("plugin_error and plugin-side kinds stay domain errors", () => {
    expect(pluginBoundaryReason("plugin_error")).toBeNull();
    expect(pluginBoundaryReason("usage")).toBeNull();
    expect(pluginBoundaryReason("not_a_repo")).toBeNull();
    expect(pluginBoundaryReason("")).toBeNull();
  });

  test("surface-specific dependency codes opt in via extraUnreachable", () => {
    expect(pluginBoundaryReason("session_unreachable")).toBeNull();
    expect(pluginBoundaryReason("session_unreachable", ["session_unreachable"])).toBe(
      "unreachable",
    );
    expect(pluginBoundaryReason("conversations_unavailable", ["conversations_unavailable"])).toBe(
      "unreachable",
    );
  });
});

describe("pluginErrorCode / pluginErrorDetail / pluginErrorFields", () => {
  test("extracts code, message and bounded fields uniformly", () => {
    const error = Object.assign(new Error("boom"), {
      code: "plugin_timeout",
      fields: { pane_id: "w1:p1" },
    });
    expect(pluginErrorCode(error)).toBe("plugin_timeout");
    expect(pluginErrorDetail(error)).toBe("boom");
    expect(pluginErrorFields(error)).toEqual({ pane_id: "w1:p1" });
  });

  test("non-error values degrade safely", () => {
    expect(pluginErrorCode("boom")).toBe("");
    expect(pluginErrorCode(null)).toBe("");
    expect(pluginErrorCode({ code: 42 })).toBe("");
    expect(pluginErrorDetail("boom")).toBe("boom");
    expect(pluginErrorFields({ fields: [1, 2] })).toBeUndefined();
    expect(pluginErrorFields({ fields: "x" })).toBeUndefined();
    expect(pluginErrorFields(new Error("x"))).toBeUndefined();
  });
});
