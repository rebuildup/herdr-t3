/**
 * Paste payload hygiene for transports that wrap the text themselves.
 *
 * herdr `pane.send_input` routes the body through `encode_api_text`,
 * which wraps it in `\x1b[200~…\x1b[201~` iff the pane enabled bracketed
 * paste, but does not sanitize the body — clipboard text containing ESC
 * (e.g. copied terminal output holding `\x1b[201~`) would terminate the
 * bracket early and execute the remainder. libghostty's own encoder
 * replaces such bytes with a space; we mirror that minimal rule here.
 * (`pane.send_text` sends raw bytes with no wrapping and is reserved for
 * literal-text delivery; it is not the paste path.)
 */
export function sanitizePasteText(text: string): string {
  return text.replaceAll("\u001b", " ");
}
