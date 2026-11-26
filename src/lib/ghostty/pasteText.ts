/**
 * Paste payload hygiene for transports that wrap the text themselves.
 *
 * herdr `pane.send_text` wraps the body in `\x1b[200~…\x1b[201~` iff the
 * pane enabled bracketed paste, but does not sanitize the body — clipboard
 * text containing ESC (e.g. copied terminal output holding `\x1b[201~`)
 * would terminate the bracket early and execute the remainder. libghostty's
 * own encoder replaces such bytes with a space; we mirror that minimal rule
 * here until the attach protocol exposes the pane's paste mode
 * (herdrdev/herdr#6215) and the local encoder can be used again.
 */
export function sanitizePasteText(text: string): string {
  return text.replaceAll("\u001b", " ");
}
