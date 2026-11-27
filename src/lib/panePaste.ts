import type { RpcMethod } from "../../shared/protocol.ts";
import { sanitizePasteText } from "./ghostty/pasteText.ts";

type RpcSend = (
  method: RpcMethod,
  params: Record<string, unknown>,
  machine: string,
) => Promise<unknown>;

/**
 * Deliver clipboard text to a pane through herdr `pane.send_input`
 * (issue #434, fixed for #478).
 *
 * `pane.send_input` routes the body through herdr's `encode_api_text`,
 * which wraps it in `\x1b[200~…\x1b[201~` iff the pane enabled bracketed
 * paste — the attach stream carries no mode state, so the local engine
 * could never bracket (herdrdev/herdr#6215). With `keys: []` only the
 * encoded text is sent. `pane.send_text` sends raw bytes with no
 * wrapping and stays reserved for literal-text delivery
 * (PaneMessageDialog, artifacts).
 *
 * Failures are swallowed like the other fire-and-forget pane inputs:
 * a dropped paste must not surface as an unhandled rejection.
 */
export function deliverPanePaste(
  send: RpcSend,
  machine: string,
  paneId: string,
  text: string,
): void {
  void send(
    "pane.send_input",
    { pane_id: paneId, text: sanitizePasteText(text), keys: [] },
    machine,
  ).catch(() => {});
}
