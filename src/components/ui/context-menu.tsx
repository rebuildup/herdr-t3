/*
 * Context menu primitive styled to match the vendored T3 `ui/menu`
 * popup (dropdown-glass, rounded-lg, p-1, T3 item metrics). T3 Code drives
 * context menus through the OS/native menu on desktop; herdr-t3 uses
 * Base UI's context-menu primitive for the same interaction.
 */
import { ContextMenu as BaseContextMenu } from "@base-ui/react/context-menu";
import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

const itemClass =
  "flex min-h-8 cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1 text-base text-foreground outline-none data-disabled:pointer-events-none data-disabled:cursor-not-allowed data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:opacity-64 sm:min-h-7 sm:text-sm [&>svg:not([class*='size-'])]:size-4.5 sm:[&>svg:not([class*='size-'])]:size-4 [&>svg:not([class*='text-'])]:text-muted-foreground [&>svg]:pointer-events-none [&>svg]:shrink-0";
const destructiveClass = "text-destructive [&>svg:not([class*='text-'])]:text-current";

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

export function ContextMenuContent({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <BaseContextMenu.Portal>
      <BaseContextMenu.Positioner className="z-[130]" sideOffset={4}>
        <BaseContextMenu.Popup
          className={cn(
            "dropdown-glass relative w-max min-w-40 max-w-[calc(100vw-2rem)] rounded-lg shadow-[0_16px_40px_-18px_rgb(0_0_0/55%)] outline-none dark:shadow-[0_18px_44px_-12px_rgb(0_0_0/90%)] dark:ring-1 dark:ring-foreground/10",
            "[-webkit-app-region:no-drag]",
          )}
        >
          <div className={cn("max-h-(--available-height) w-full overflow-y-auto p-1", className)}>
            {children}
          </div>
        </BaseContextMenu.Popup>
      </BaseContextMenu.Positioner>
    </BaseContextMenu.Portal>
  );
}

export function ContextMenuItem({
  children,
  onSelect,
  disabled,
  destructive,
}: {
  children: ReactNode;
  onSelect?: () => void;
  disabled?: boolean;
  destructive?: boolean;
}) {
  return (
    <BaseContextMenu.Item
      className={cn(itemClass, destructive && destructiveClass)}
      onClick={onSelect}
      disabled={disabled}
    >
      {children}
    </BaseContextMenu.Item>
  );
}

export function ContextMenuSeparator() {
  return <BaseContextMenu.Separator className="mx-2 my-1 h-px bg-border" />;
}
