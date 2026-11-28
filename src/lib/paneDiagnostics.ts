import { useEffect, useState } from "react";

import { rpc } from "./api";
import type { PaneProcessInfo } from "../../shared/protocol";

interface ExplainResult {
  explain?: Record<string, unknown>;
}

interface ReadResult {
  read?: { text?: string; truncated?: boolean };
}

export interface PaneDiagnostics {
  processInfo: PaneProcessInfo | null;
  processError: string | null;
  explain: Record<string, unknown> | null;
  recentOutput: string | null;
  outputTruncated: boolean;
}

/**
 * On-demand pane diagnostics (issue #390): the whitelisted
 * `pane.process_info` / `agent.explain` / `agent.read` RPCs shared by
 * `PaneDetailsDialog` (internal IDs) and `PaneContextCard` (context
 * card). Each fetch fails independently so older herdr versions degrade
 * field by field; agent reads only run for agent panes. Fetches start
 * when the calling component mounts — render the hook inside a surface
 * that only exists while open.
 */
export function usePaneDiagnostics(
  paneId: string | null,
  machine: string,
  isAgent: boolean,
  includeOutput = true,
): PaneDiagnostics {
  const [processInfo, setProcessInfo] = useState<PaneProcessInfo | null>(null);
  const [processError, setProcessError] = useState<string | null>(null);
  const [explain, setExplain] = useState<Record<string, unknown> | null>(null);
  const [recentOutput, setRecentOutput] = useState<string | null>(null);
  const [outputTruncated, setOutputTruncated] = useState(false);

  useEffect(() => {
    setProcessInfo(null);
    setProcessError(null);
    setExplain(null);
    setRecentOutput(null);
    setOutputTruncated(false);
    if (!paneId) return;
    let cancelled = false;
    void rpc<{ process_info?: PaneProcessInfo }>(
      "pane.process_info",
      { pane_id: paneId },
      machine,
    )
      .then((res) => {
        if (!cancelled) setProcessInfo(res?.process_info ?? null);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setProcessError(error instanceof Error ? error.message : String(error));
        }
      });
    if (isAgent) {
      void rpc<ExplainResult>("agent.explain", { target: paneId }, machine)
        .then((res) => {
          if (!cancelled && res?.explain) setExplain(res.explain);
        })
        .catch(() => {});
    }
    if (isAgent && includeOutput) {
      void rpc<ReadResult>(
        "agent.read",
        { target: paneId, lines: 30, format: "text", strip_ansi: true },
        machine,
      )
        .then((res) => {
          if (!cancelled && res?.read?.text !== undefined) {
            setRecentOutput(res.read.text);
            setOutputTruncated(res.read.truncated === true);
          }
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [paneId, machine, isAgent, includeOutput]);

  return { processInfo, processError, explain, recentOutput, outputTruncated };
}
