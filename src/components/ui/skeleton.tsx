/*
 * Ported from T3 Code (MIT, © 2026 T3 Tools Inc.).
 * Source: apps/web/src/components/ui/skeleton.tsx @ 9cc4018c.
 * Local change: header comment only.
 */
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "~/lib/utils";

const skeletonVariants = cva("bg-muted-foreground/15 motion-safe:animate-skeleton", {
  variants: {
    shape: {
      block: "rounded-sm",
      card: "rounded-lg",
      pill: "rounded-full",
    },
  },
  defaultVariants: { shape: "block" },
});

function Skeleton({
  className,
  shape,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof skeletonVariants>) {
  return (
    <div className={cn(skeletonVariants({ shape }), className)} data-slot="skeleton" {...props} />
  );
}

export { Skeleton };
