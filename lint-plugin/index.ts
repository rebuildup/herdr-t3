import { definePlugin } from "@oxlint/plugins";

import noNativeTitleTooltip from "./rules/no-native-title-tooltip.ts";
import noRawBadge from "./rules/no-raw-badge.ts";
import noRawControl from "./rules/no-raw-control.ts";
import noRawResizeObserver from "./rules/no-raw-resize-observer.ts";
import noStaticInlineStyle from "./rules/no-static-inline-style.ts";
import noTextButtonInSurfaceSlot from "./rules/no-text-button-in-surface-slot.ts";
import requireSuppressionReason from "./rules/require-suppression-reason.ts";

export default definePlugin({
  meta: { name: "herdr-t3" },
  rules: {
    "no-native-title-tooltip": noNativeTitleTooltip,
    "no-raw-badge": noRawBadge,
    "no-raw-control": noRawControl,
    "no-raw-resize-observer": noRawResizeObserver,
    "no-static-inline-style": noStaticInlineStyle,
    "no-text-button-in-surface-slot": noTextButtonInSurfaceSlot,
    "require-suppression-reason": requireSuppressionReason,
  },
});
