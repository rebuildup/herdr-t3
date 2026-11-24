/**
 * Move keyboard focus back to the working terminal after a menu/palette
 * action (issue #128, interaction.md: focus returns to the working
 * surface). The pane wrapper focused by the latest herdr snapshot carries
 * `data-focused`; the hidden textarea inside `.ghostty-surface` owns
 * input. The pushed snapshot may still be in flight when the action
 * returns, and focusing the stale `data-focused` pane would target the
 * wrong terminal — so focus is attempted twice on a bounded schedule:
 * early enough to feel instant, late enough for the snapshot to land.
 */
export function focusPaneTerminal(): void {
  const tryFocus = () => {
    document
      .querySelector<HTMLElement>('[data-focused="true"] .ghostty-input')
      ?.focus();
  };
  setTimeout(tryFocus, 200);
  setTimeout(tryFocus, 800);
}
