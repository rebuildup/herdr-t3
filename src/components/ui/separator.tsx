/*
 * Ported from T3 Code (MIT, © 2026 T3 Tools Inc.).
 * Source: apps/web/src/components/ui/separator.tsx @ 9cc4018c.
 * Local change: header comment only.
 */
import { Separator as SeparatorPrimitive } from "@base-ui/react/separator";

import { cn } from "~/lib/utils";

function Separator({ className, orientation = "horizontal", ...props }: SeparatorPrimitive.Props) {
  return (
    <SeparatorPrimitive
      className={cn(
        "shrink-0 bg-border data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:w-px data-[orientation=vertical]:not-[[class^='h-']]:not-[[class*='_h-']]:self-stretch",
        className,
      )}
      data-slot="separator"
      orientation={orientation}
      {...props}
    />
  );
}

export { Separator };
