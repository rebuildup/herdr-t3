import { ContextMenu as BaseContextMenu } from "@base-ui/react/context-menu";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

const itemClass =
  "flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none select-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50";

export function ContextMenu({ children }: { children: ReactNode }) {
  return <BaseContextMenu.Root>{children}</BaseContextMenu.Root>;
}

export function ContextMenuTrigger({ children, className }: { children: ReactNode; className?: string }) {
  // Render a div, not the default button: rows inside the trigger are
  // themselves buttons, and button-in-button is invalid HTML.
  return (
    <BaseContextMenu.Trigger
      className={cn("outline-none", className)}
      render={<div />}
    >
      {children}
    </BaseContextMenu.Trigger>
  );
}

export function ContextMenuContent({ children }: { children: ReactNode }) {
  return (
    <BaseContextMenu.Portal>
      <BaseContextMenu.Positioner className="z-50">
        <BaseContextMenu.Popup className="min-w-40 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md">
          {children}
        </BaseContextMenu.Popup>
      </BaseContextMenu.Positioner>
    </BaseContextMenu.Portal>
  );
}

export function ContextMenuItem({
  children,
  onSelect,
  disabled,
}: {
  children: ReactNode;
  onSelect?: () => void;
  disabled?: boolean;
}) {
  return (
    <BaseContextMenu.Item className={itemClass} onClick={onSelect} disabled={disabled}>
      {children}
    </BaseContextMenu.Item>
  );
}

export function ContextMenuSeparator() {
  return <BaseContextMenu.Separator className="my-1 h-px bg-border" />;
}
