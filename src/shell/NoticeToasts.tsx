/*
 * Notice toasts (issue #113, reworked for #428): transient notification
 * cards rendered through the shared T3 toast primitive
 * (src/components/ui/toast.tsx over Base UI Toast). Placement comes from
 * Settings → Notifications (src/lib/settings.ts, persisted, default
 * top-right) and applies live; top positions clear the reserved
 * titlebar/WCO area via --workspace-topbar-height. The notices store
 * (src/shell/notices.ts) stays the semantic source — attention.ts
 * pushes, this surface only renders.
 */
import { useSyncExternalStore } from "react";

import {
  ToastProvider,
  type ToastPosition,
} from "~/components/ui/toast";
import {
  getNotificationsSettings,
  onNotificationsSettingsChange,
} from "~/lib/settings";
import { MAX_NOTICES } from "./notices";

function useNotificationPosition(): ToastPosition {
  return useSyncExternalStore(
    onNotificationsSettingsChange,
    () => getNotificationsSettings().position,
    () => getNotificationsSettings().position,
  );
}

export function NoticeToasts() {
  const position = useNotificationPosition();
  return (
    // timeout=0: the per-toast visible-time auto-dismiss inside the
    // primitive owns dismissal so hidden/unfocused/hovered toasts wait.
    <ToastProvider position={position} timeout={0} limit={MAX_NOTICES}>
      {null}
    </ToastProvider>
  );
}
