/*
 * StatusBadge is the typed status channel for the design system (AC-003,
 * docs/design/anti-cases.md). Raw <Badge> is reserved for genuine
 * classification; status indicators express their meaning through `status`
 * so the variant mapping stays in one place.
 */
import type { ComponentProps } from "react";

import { Badge } from "./badge";

export type StatusBadgeStatus = "ok" | "info" | "warning" | "error" | "neutral";

const STATUS_VARIANT = {
  ok: "success",
  info: "info",
  warning: "warning",
  error: "error",
  neutral: "outline",
} as const;

interface StatusBadgeProps extends Omit<ComponentProps<typeof Badge>, "variant"> {
  status: StatusBadgeStatus;
}

function StatusBadge({ status, ...props }: StatusBadgeProps) {
  return <Badge variant={STATUS_VARIANT[status]} {...props} />;
}

export { StatusBadge };
