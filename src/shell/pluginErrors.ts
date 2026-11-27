/**
 * Shared plugin-boundary error classification (issue #538).
 *
 * Every `plugin_call`/`plugin_list`/capability failure crosses the bridge
 * as an error `code`. The bridge emits a fixed boundary vocabulary
 * (`plugin_not_installed`, `plugin_disabled`, `plugin_incompatible`,
 * `plugin_unsupported_command`, `plugin_bad_output`, `plugin_timeout`,
 * `plugin_exec_failed`, `plugin_host_unreachable`, `machine_unavailable`,
 * `connect_failed`, `unreachable`) while plugins contribute their own
 * contract `kind`/`code` values. Before this module each surface
 * re-implemented the same switch and drifted: `plugin_timeout` and
 * `plugin_exec_failed` were `unreachable` on some surfaces, `error` or a
 * domain fallback (`git_error`, `plugin_error`) on others.
 *
 * `pluginBoundaryReason` is the single boundary-code → reason mapper.
 * Surfaces keep their own domain-error fallbacks (known plugin kinds
 * stay verbatim; unknown codes degrade to the surface's generic error
 * code) — this helper only owns the boundary half of the classification.
 */

/** Boundary reasons shared by every plugin surface's unavailable union. */
export type PluginBoundaryReason =
  | "not_installed"
  | "disabled"
  | "incompatible"
  | "unreachable";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The bridge/plugin error `code`, or "" when the failure carries none. */
export function pluginErrorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "";
}

/** Human-readable detail: Error.message when present, else String(error). */
export function pluginErrorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Bounded contract extras forwarded by the bridge in `error.fields`
 * (issue #257). Returns undefined when absent or not a plain object —
 * older plugin revisions and non-plugin failures carry none.
 */
export function pluginErrorFields(error: unknown): Record<string, unknown> | undefined {
  const fields = (error as { fields?: unknown } | null)?.fields;
  return isRecord(fields) ? fields : undefined;
}

/**
 * Boundary code → shared reason. `plugin_timeout` and
 * `plugin_exec_failed` map to `unreachable`: both mean the plugin
 * process could not be reached to completion (queue/exec deadline
 * exceeded, or the spawn/transport itself failed) — never a
 * plugin-reported domain failure. `plugin_error` is deliberately absent:
 * it is the plugin's own generic failure and stays a domain error.
 *
 * `extraUnreachable` lets a surface keep its own dependency codes that
 * mean the same thing (e.g. `session_unreachable`,
 * `conversations_unavailable`) without forking the boundary table.
 */
const BOUNDARY_REASONS: Readonly<Record<string, PluginBoundaryReason>> = {
  plugin_not_installed: "not_installed",
  plugin_disabled: "disabled",
  plugin_incompatible: "incompatible",
  plugin_unsupported_command: "incompatible",
  plugin_bad_output: "incompatible",
  plugin_host_unreachable: "unreachable",
  plugin_timeout: "unreachable",
  plugin_exec_failed: "unreachable",
  machine_unavailable: "unreachable",
  connect_failed: "unreachable",
  unreachable: "unreachable",
};

export function pluginBoundaryReason(
  code: string,
  extraUnreachable: readonly string[] = [],
): PluginBoundaryReason | null {
  const mapped = BOUNDARY_REASONS[code];
  if (mapped !== undefined) return mapped;
  if (extraUnreachable.includes(code)) return "unreachable";
  return null;
}
