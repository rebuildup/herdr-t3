/*
 * Header icon button — ghost icon Button wrapped in a bottom tooltip.
 * Shared by the workspace header's pane actions and the tab strip's
 * new-tab affordance (extracted with TabStrip for issue #550 so both
 * stay reviewable in Storybook).
 */
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

export function HeaderIconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={label}
            disabled={disabled}
            onClick={onClick}
            className="[-webkit-app-region:no-drag]"
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
}
