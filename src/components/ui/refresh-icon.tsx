/*
 * Ported from T3 Code (MIT, © 2026 T3 Tools Inc.).
 * Source: apps/web/src/components/ui/refresh-icon.tsx @ 9cc4018c.
 * Local changes: header comment only.
 */
import { RefreshCwIcon } from "lucide-react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "~/lib/utils";
import { observeVisibleAnimation } from "~/lib/visibleAnimation";

// No default size: inside a Button the parent's svg rule sizes the glyph.
const refreshIconVariants = cva("", {
  variants: {
    size: {
      xs: "size-3",
      sm: "size-3.5",
      md: "size-4",
      lg: "size-5",
    },
  },
});

export function RefreshIcon({
  refreshing = false,
  className,
  size,
  ...props
}: React.ComponentPropsWithoutRef<typeof RefreshCwIcon> &
  VariantProps<typeof refreshIconVariants> & { refreshing?: boolean }) {
  return (
    <RefreshCwIcon
      aria-hidden
      ref={refreshing ? observeVisibleAnimation : undefined}
      className={cn(
        refreshIconVariants({ size }),
        refreshing && "motion-safe:visible-animate-spin",
        className,
      )}
      {...props}
    />
  );
}
