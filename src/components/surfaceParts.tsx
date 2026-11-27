/*
 * Shared right-panel surface composition primitives (issues #409/#410).
 * Not T3 ports — these compose `src/components/ui/` primitives into the
 * section/empty/loading treatments T3 feature screens use
 * (`ThreadDetailsSection`, `DiffPanelShell`, `DiffFileTree` header rows,
 * `DiffPanelLoadingState`), so plugin surfaces stop hand-rolling them.
 *
 * Type hierarchy per docs/design/conformance-audit.md §4: `text-sm`
 * primary, `text-xs` secondary, `text-2xs` metadata only.
 */
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import { Skeleton } from "./ui/skeleton";

/**
 * Section block: T3 `ThreadDetailsSection` composition — a `text-2xs
 * font-medium text-muted-foreground` heading row (title left, optional
 * count/actions right) over the section body, sections separated by a
 * top border. `first:border-t-0` keeps the leading section flush.
 */
export function SurfaceSection({
  title,
  count,
  description,
  actions,
  className,
  children,
}: {
  title: string;
  /** Small tabular count rendered after the title (T3 "Files N"). */
  count?: number | undefined;
  /** One-line muted explainer under the header. */
  description?: ReactNode | undefined;
  actions?: ReactNode | undefined;
  className?: string | undefined;
  children: ReactNode;
}) {
  return (
    <section
      className={cn(
        "flex flex-col gap-2 border-t border-border/60 pt-3 first:border-t-0 first:pt-0",
        className,
      )}
    >
      <div className="flex min-h-8 min-w-0 items-center justify-between gap-2">
        <h3 className="flex min-w-0 items-baseline gap-1.5 text-2xs font-medium text-muted-foreground select-none">
          <span className="truncate">{title}</span>
          {count !== undefined ? (
            <span className="shrink-0 tabular-nums">{count}</span>
          ) : null}
        </h3>
        {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
      </div>
      {description ? (
        <p className="text-xs text-muted-foreground">{description}</p>
      ) : null}
      {children}
    </section>
  );
}

/**
 * In-column group header — T3 `DiffFileTree` header row treatment
 * (`Files` label + count + accessory) for sub-groups inside a section,
 * without the section's border/padding.
 */
export function SurfaceGroupHeader({
  title,
  count,
  actions,
}: {
  title: string;
  count?: number | undefined;
  actions?: ReactNode | undefined;
}) {
  return (
    <div className="flex h-8 min-w-0 items-center gap-1 px-1 text-xs text-muted-foreground">
      <span className="min-w-0 truncate font-medium text-foreground">{title}</span>
      {count !== undefined ? (
        <span className="shrink-0 tabular-nums">{count}</span>
      ) : null}
      {actions ? <span className="ml-auto flex shrink-0 items-center gap-1">{actions}</span> : null}
    </div>
  );
}

/**
 * One-line status note — T3's muted/error text treatment for inline
 * messages (empty results, classified failures, mutation feedback).
 */
export function SurfaceNote({
  tone = "muted",
  className,
  children,
}: {
  tone?: "muted" | "error" | "warning" | "success" | undefined;
  className?: string | undefined;
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
    >
      {children}
    </p>
  );
}

/**
 * Inline empty state — T3 `DiffPanel`'s centered muted treatment for
 * panel/section-level "nothing here" states (sm title + xs muted
 * description). The full `Empty*` primitives are sized for whole-panel
 * states (plugin unavailable, first-run); in-column sections use this
 * lighter treatment, matching T3's diff/preview panes.
 */
export function SurfaceEmpty({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description?: ReactNode | undefined;
  /** Optional actions/content under the description (buttons, hints). */
  children?: ReactNode | undefined;
  className?: string | undefined;
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

/**
 * Loading placeholder — T3 `DiffPanelLoadingState` treatment: a stack
 * of `Skeleton` rows standing in for list content, announced via
 * `role="status"`.
 */
export function SurfaceLoading({
  label,
  rows = 4,
  className,
}: {
  label: string;
  rows?: number | undefined;
  className?: string | undefined;
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
            className={cn("h-3", i % 3 === 0 ? "w-3/5" : i % 3 === 1 ? "w-2/5" : "w-1/2")}
          />
        </div>
      ))}
      <span className="sr-only">{label}</span>
    </div>
  );
}

/**
 * Shared mutation feedback line: classified error in destructive tone,
 * otherwise the one-line success notice. Replaces the per-surface
 * `MutationFeedback` copies.
 */
export function MutationFeedback({
  error,
  notice,
}: {
  error: string | null;
  notice: string | null;
}) {
  if (error !== null) {
    return <SurfaceNote tone="error">{error}</SurfaceNote>;
  }
  if (notice !== null) {
    return <SurfaceNote>{notice}</SurfaceNote>;
  }
  return null;
}
