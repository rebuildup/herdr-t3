/*
 * Surface composition primitives — the single shared module for the
 * plugin surfaces (consolidates the #409 `surfaceParts.tsx`, #410
 * `surfaceLayout.tsx`, and #411 `surfacePanel.tsx` helpers). Two
 * T3-derived families live here:
 *
 * - Panel/settings density (the analog of T3 Code's
 *   `apps/web/src/components/settings/settingsLayout.tsx` +
 *   `itemRows.ts` @ 9cc4018c): `SurfaceSection`, `SurfacePanelHeader`,
 *   `SurfaceGroup`, `SurfaceRow`, `SurfaceLoadingRow`,
 *   `SurfaceSkeletonRows`.
 * - Details/inline density (the analog of T3's `ThreadDetailsSection`,
 *   `DiffFileTree` header rows, `DiffPanel` empty/loading treatments):
 *   `SurfaceDetailsSection`, `SurfaceGroupHeader`, `SurfaceNote`,
 *   `SurfaceEmpty`, `SurfaceLoadingRows`, `MutationFeedback`.
 *
 * Type hierarchy follows the conformance baseline
 * (docs/design/conformance-audit.md §4): `text-sm` primary, `text-xs`
 * secondary, `text-2xs` only for badge-adjacent metadata.
 */
import type { ComponentProps, ReactNode } from "react";

import { cn } from "~/lib/utils";
import { Skeleton } from "./ui/skeleton";

/**
 * Surface header row — T3's titled-section composition (`text-sm
 * font-medium` title, `text-xs` muted description, right-aligned
 * action slot for refresh/mutation controls). Used standalone at the
 * top of a scroll panel, and composed by `SurfaceSection`.
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
 * Section wrapper: `SurfacePanelHeader` over the section body inside a
 * `flex flex-col gap-2` `<section>` — T3 `h2` section header (cf.
 * UsagePage) with an optional right-aligned action slot.
 */
export function SurfaceSection({
  title,
  description,
  action,
  className,
  children,
  ...sectionProps
}: Omit<ComponentProps<"section">, "title"> & {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className={cn("flex flex-col gap-2", className)} {...sectionProps}>
      <SurfacePanelHeader title={title} description={description} actions={action} />
      {children}
    </section>
  );
}

/**
 * Details-density section block — T3 `ThreadDetailsSection`
 * composition: a `text-2xs font-medium text-muted-foreground` heading
 * row (title left, optional count/actions right) over the section
 * body, sections separated by a top border. `first:border-t-0` keeps
 * the leading section flush. Distinct from `SurfaceSection`: this is
 * the muted-heading, border-separated treatment used inside detail
 * panels (Git, Checkpoints), not the `text-sm` titled-section header.
 */
export function SurfaceDetailsSection({
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
 * Grouped row container — T3 `SettingsGroup` (`rounded-xl border
 * border-border/60 bg-card/40`) with divided rows. `divided={false}`
 * leaves spacing to the children (e.g. tables that draw their own
 * rules).
 */
export function SurfaceGroup({
  divided = true,
  className,
  children,
  ...props
}: ComponentProps<"div"> & { divided?: boolean }) {
  return (
    <div
      data-slot="surface-group"
      className={cn(
        "overflow-hidden rounded-xl border border-border/60 bg-card/40",
        divided && "divide-y divide-border/50",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

/**
 * Row inside a `SurfaceGroup` — T3 `SettingsRow` density
 * (`px-3 py-2.5 sm:px-4`) with the title/description type ramp. Pass
 * `title`/`description` for the common case, or compose children for
 * richer rows (badges, controls, nested content).
 */
export function SurfaceRow({
  title,
  description,
  className,
  children,
  ...props
}: Omit<ComponentProps<"div">, "title"> & {
  title?: ReactNode;
  description?: ReactNode;
}) {
  const hasHeader = title !== undefined || description !== undefined;
  return (
    <div
      data-slot="surface-row"
      className={cn("px-3 py-2.5 sm:px-4", className)}
      {...props}
    >
      {hasHeader ? (
        <div className="flex min-w-0 flex-col gap-0.5">
          {title !== undefined ? (
            <h3 className="text-sm font-medium text-foreground">{title}</h3>
          ) : null}
          {description !== undefined ? (
            <div className="text-xs text-muted-foreground">{description}</div>
          ) : null}
        </div>
      ) : null}
      {children}
    </div>
  );
}

/**
 * Status line inside a `SurfaceGroup` for the loading state — a muted
 * `role="status"` row, matching T3's `SettingsRow title="Loading…"`
 * idiom. Compose `SurfaceSkeletonRows` instead when the shape is
 * known.
 */
export function SurfaceLoadingRow({ children }: { children?: ReactNode }) {
  return (
    <SurfaceRow>
      <p className="text-sm text-muted-foreground" role="status">
        {children ?? "Loading…"}
      </p>
    </SurfaceRow>
  );
}

const SKELETON_LINES = [
  <div key="line-1" className="flex items-center gap-2.5">
    <Skeleton shape="pill" className="size-4 shrink-0" />
    <Skeleton className="h-3.5 w-2/3" />
  </div>,
  <div key="line-2" className="flex items-center gap-2.5">
    <Skeleton shape="pill" className="size-4 shrink-0" />
    <Skeleton className="h-3.5 w-1/2" />
  </div>,
  <div key="line-3" className="flex items-center gap-2.5">
    <Skeleton shape="pill" className="size-4 shrink-0" />
    <Skeleton className="h-3.5 w-3/5" />
  </div>,
  <div key="line-4" className="flex items-center gap-2.5">
    <Skeleton shape="pill" className="size-4 shrink-0" />
    <Skeleton className="h-3.5 w-2/5" />
  </div>,
] as const;

/**
 * Skeleton loading state inside a `SurfaceGroup` — the T3
 * `Skeleton`-row idiom (cf. UsagePage `UsageSkeleton`) for sections
 * whose content shape is a list of rows. For a standalone loading
 * placeholder outside a group, use `SurfaceLoadingRows`.
 */
export function SurfaceSkeletonRows({ rows = 3 }: { rows?: number }) {
  return (
    <SurfaceGroup
      divided={false}
      role="status"
      aria-label="Loading"
      className="flex flex-col gap-2.5 p-3"
    >
      {SKELETON_LINES.slice(0, Math.min(rows, SKELETON_LINES.length))}
    </SurfaceGroup>
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
 * Compact inline empty state — T3's centered muted treatment for
 * section-level "nothing here" states inside a scroll panel (sm title
 * + xs muted description). For a full-surface empty with an icon or a
 * recovery CTA, compose the `Empty*` primitives instead.
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

/**
 * Loading placeholder — T3 `DiffPanelLoadingState` treatment: a stack
 * of `Skeleton` rows standing in for list content, announced via
 * `role="status"`. Standalone (not wrapped in `SurfaceGroup`); inside
 * a group use `SurfaceSkeletonRows` or `SurfaceLoadingRow`.
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
 * Shared mutation feedback line: classified error in destructive tone,
 * otherwise the one-line success notice.
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
