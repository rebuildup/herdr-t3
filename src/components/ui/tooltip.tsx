import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";

/**
 * T3-style tooltip. Use instead of the native `title` attribute, which is
 * unstyled, slow, and inaccessible to keyboard users. `children` must be a
 * single element — its props are preserved and trigger props merged onto it.
 */
export function Tooltip({ content, children }: { content: ReactNode; children: ReactNode }) {
  const child = Children.only(children);
  const trigger = isValidElement(child) ? (child as ReactElement) : <span>{child}</span>;
  return (
    <BaseTooltip.Root>
      <BaseTooltip.Trigger render={trigger} />
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner className="z-50">
          <BaseTooltip.Popup className="rounded-md border border-border bg-popover px-2 py-1 text-2xs text-popover-foreground shadow-md">
            {content}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
}
