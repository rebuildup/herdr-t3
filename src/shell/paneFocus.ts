/**
 * Move keyboard focus back to a pane's terminal input after a menu/palette
 * action (issue #128, interaction.md: focus returns to the working
 * surface). The pane wrapper carries `data-pane-id`; the hidden textarea
 * inside `.ghostty-surface` owns input.
 */
export function focusPaneTerminal(paneId: string | null | undefined): void {
  if (!paneId) return;
  const input = document.querySelector<HTMLElement>(
    `[data-pane-id="${CSS.escape(paneId)}"] .ghostty-input`,
  );
  input?.focus();
}
