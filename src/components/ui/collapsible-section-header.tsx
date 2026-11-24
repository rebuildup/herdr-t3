/*
 * Ported from T3 Code (MIT, © 2026 T3 Tools Inc.).
 * Source: apps/web/src/components/ui/collapsible-section-header.tsx @ 9cc4018c.
 * Local changes: `chevron` variant — T3's trailing chevron leaves the count
 * ~20px left of the row right rail; leading placement lets the count sit
 * flush with row content (issue #204 review). Default stays verbatim.
 */
import type { ComponentProps, ReactNode } from "react";
import { ChevronDownIcon } from "lucide-react";
import { cn } from "~/lib/utils";

const tones = {
  muted: { label: "text-sidebar-muted-foreground", line: "bg-sidebar-border/50" },
  emphasized: { label: "text-sidebar-foreground/80", line: "bg-sidebar-foreground/25" },
  accent: { label: "text-primary", line: "bg-primary/50" },
} as const;

export function CollapsibleSectionHeader({
  children,
  expanded,
  tone = "muted",
  variant = "default",
  chevron = "trailing",
  accessory,
  ...buttonProps
}: Omit<ComponentProps<"button">, "className" | "style" | "aria-expanded"> & {
  expanded: boolean;
  tone?: keyof typeof tones;
  variant?: "default" | "panel";
  /** "leading" moves the disclosure chevron before the label so the
      trailing accessory can align with the row content rail. */
  chevron?: "trailing" | "leading";
  accessory?: ReactNode;
}) {
  const leading = chevron === "leading";
  const disclosure = (
    <ChevronDownIcon
      aria-hidden
      className={cn("size-3 shrink-0 transition-transform", !expanded && "-rotate-90")}
    />
  );
  return (
    <button
      {...buttonProps}
      type="button"
      aria-expanded={expanded}
      className={cn(
        "flex h-8 w-full cursor-pointer items-center gap-2 rounded-md text-left text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
        variant === "panel" ? "ps-2 pe-2.5" : "px-2",
        // Row-rail padding: the trailing count must end where row content
        // ends (--sidebar-row-content-inset), not at the px-2 edge.
        leading && "pe-[var(--sidebar-row-content-inset)]",
        tones[tone].label,
      )}
    >
      {leading ? disclosure : null}
      <span className="min-w-0 truncate">{children}</span>
      <span
        aria-hidden
        // A header with a trailing count drops its rule so it doesn't read as a leader.
        className={cn("h-px min-w-2 flex-1", tones[tone].line, accessory && "invisible")}
      />
      {accessory}
      {leading ? null : disclosure}
    </button>
  );
}
