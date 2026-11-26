import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";

import { cn } from "~/lib/utils";

/**
 * Progressive-disclosure row (issue #389): port of T3 Code's
 * `ThreadDetailsMoreButton` (`components/chat/ThreadDetailsControl.tsx`)
 * and the sidebar's `settled:more` row — a muted full-width row with a
 * leading chevron that reveals the next page of hidden items. Used by
 * the Agents shelves and, later, details-card lists (#390).
 */
export function ShowMoreButton({
  remaining,
  expanded = false,
  onToggle,
  className,
}: {
  /** Items still hidden; the label shows at most this many are revealed next. */
  remaining: number;
  expanded?: boolean;
  onToggle: () => void;
  className?: string;
}) {
  const Icon = expanded ? ChevronUpIcon : ChevronDownIcon;
  return (
    // oxlint-disable-next-line herdr-t3/no-raw-control -- disclosure row inside composite lists, same exception as T3's settled:more row
    <button
      type="button"
      aria-expanded={expanded}
      onClick={onToggle}
      className={cn(
        "flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-left text-sm text-sidebar-muted-foreground transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
        className,
      )}
    >
      <Icon aria-hidden className="size-4 shrink-0" />
      {expanded ? "Show less" : `Show ${remaining} more`}
    </button>
  );
}
