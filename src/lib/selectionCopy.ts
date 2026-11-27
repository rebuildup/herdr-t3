/*
 * Copy-on-select host gate (issue #440). The terminal surface core reports a
 * selection *commit* — the user finished a non-empty local selection — via
 * `onSelectionCommit`; this module owns the app-level decision (the Terminal
 * "Copy on select" setting) and the OS clipboard write itself, keeping the
 * surface DOM-free and the clipboard adapter boundary in the host layer,
 * consistent with how OSC 52 `onClipboardWrite` is handled.
 *
 * Guarantees:
 * - the setting is read per commit, so toggling it applies to open panes
 *   without rebuilding any surface;
 * - writes are serialized in commit order, so a slow write can never land
 *   after a newer commit and clobber it — the newest selection always wins;
 * - failures are swallowed: nothing here claims success, and the selected
 *   text is never logged or transmitted anywhere.
 */

export interface SelectionCopyDeps {
  /** live read of the Terminal `copyOnSelect` setting, evaluated per commit */
  enabled(): boolean;
  /** OS clipboard write; may reject — rejections are ignored */
  writeText(text: string): Promise<unknown>;
}

/**
 * Returns the `onSelectionCommit` handler for one pane. Each committed
 * selection produces at most one clipboard write, and only while the
 * setting is on.
 */
export function createSelectionCopy(deps: SelectionCopyDeps): (text: string) => void {
  // Serializes writes: commit N+1's write starts only after commit N's has
  // settled, so clipboard order always matches commit order.
  let tail: Promise<void> = Promise.resolve();
  return (text) => {
    if (!deps.enabled() || text.length === 0) return;
    tail = tail.then(async () => {
      try {
        await deps.writeText(text);
      } catch {
        /* clipboard unavailable or denied — never reported as success */
      }
    });
  };
}
