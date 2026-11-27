/*
 * Right-panel surface composition helpers (issue #411): the section
 * header, status notes, loading skeletons and compact empty states the
 * plugin surfaces share, so each surface stops hand-rolling treatments
 * T3 Code feature screens compose from primitives
 * (`ThreadDetailsSection`, `DiffPanelLoadingState`, settings
 * `SettingsRow` density — see docs/design/conformance-audit.md §4).
 *
 * Type hierarchy: `text-sm` primary, `text-xs` secondary, `text-2xs`
 * metadata only. `Empty*` primitives remain the choice for full-panel
 * states that carry an icon or a recovery action.
 */
import type { ComponentProps, ReactNode } from "react";

import { cn } from "~/lib/utils";
import { Skeleton } from "./ui/skeleton";

/**
 * Surface header row — T3's titled-section composition (`text-sm
 * font-medium` title, `text-xs` muted description, right-aligned action
 * slot for refresh/mutation controls). Replaces the per-surface
 * explainer paragraph + ad-hoc button cluster.
 */
export function SurfacePanelHeader({
  title,
  description,
  actions,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 items-start justify-between gap-2", className)}>
      <div className="flex min-w-0 flex-col gap-0.5">
        <h2 className="text-sm font-medium text-foreground">{title}</h2>
        {description ? (
          <p className="text-pretty text-xs text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex shrink-0 items-center gap-1">{actions}</div>
      ) : null}
    </div>
  );
}

/**
 * One-line status note — muted explainer, classified plugin error, or
 * mutation feedback. `text-xs` keeps it on the secondary-copy rung
 * instead of the flattened `text-2xs` body copy the audit flagged.
 */
export function SurfaceNote({
  tone = "muted",
  className,
  children,
  ...props
}: Omit<ComponentProps<"p">, "children"> & {
  tone?: "muted" | "error" | "warning" | "success";
  children: ReactNode;
}) {
  return (
    <p
      className={cn(
        "text-xs",
        tone === "muted" && "text-muted-foreground",
        tone === "error" && "text-destructive",
        tone === "warning" && "text-warning-foreground",
        tone === "success" && "text-success",
        className,
      )}
      {...props}
    >
      {children}
    </p>
  );
}

/**
 * Loading placeholder — T3 `DiffPanelLoadingState` treatment: a stack
 * of `Skeleton` rows standing in for list content, announced via
 * `role="status"`.
 */
export function SurfaceLoadingRows({
  label,
  rows = 4,
  className,
}: {
  label: string;
  rows?: number;
  className?: string;
}) {
  return (
    <div
      className={cn("flex flex-col gap-1.5", className)}
      role="status"
      aria-live="polite"
      aria-label={label}
    >
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-2 px-1.5 py-1.5">
          <Skeleton shape="pill" className="h-3 w-10 shrink-0" />
          <Skeleton
            shape="pill"
            className={cn(
              "h-3",
              i % 3 === 0 ? "w-3/5" : i % 3 === 1 ? "w-2/5" : "w-1/2",
            )}
          />
        </div>
      ))}
      <span className="sr-only">{label}</span>
    </div>
  );
}

/**
 * Compact inline empty state — T3's centered muted treatment for
 * section-level "nothing here" states inside a scroll panel. For a
 * full-surface empty with an icon or a recovery CTA, compose the
 * `Empty*` primitives instead.
 */
export function SurfaceEmpty({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description?: ReactNode;
  /** Optional actions/content under the description (buttons, hints). */
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-1 items-center justify-center px-5 py-8 text-center",
        className,
      )}
    >
      <div className="flex max-w-72 min-w-0 flex-col items-center gap-1">
        <p className="text-sm font-medium text-foreground">{title}</p>
        {description ? (
          <p className="text-xs text-muted-foreground/70">{description}</p>
        ) : null}
        {children ? <div className="mt-2 flex items-center gap-2">{children}</div> : null}
      </div>
    </div>
  );
}
