import { definePlugin } from "@oxlint/plugins";

import noNativeTitleTooltip from "./rules/no-native-title-tooltip.ts";
import noRawControl from "./rules/no-raw-control.ts";
import noRawResizeObserver from "./rules/no-raw-resize-observer.ts";
import noStaticInlineStyle from "./rules/no-static-inline-style.ts";
import requireSuppressionReason from "./rules/require-suppression-reason.ts";

export default definePlugin({
  meta: { name: "herdr-t3" },
  rules: {
    "no-native-title-tooltip": noNativeTitleTooltip,
    "no-raw-control": noRawControl,
    "no-raw-resize-observer": noRawResizeObserver,
    "no-static-inline-style": noStaticInlineStyle,
    "require-suppression-reason": requireSuppressionReason,
  },
});
