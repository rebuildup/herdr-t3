/*
 * Surface composition primitives (issue #410): the panel-density analog
 * of T3 Code's settings layout (`apps/web/src/components/settings/
 * settingsLayout.tsx` + `itemRows.ts` @ 9cc4018c) — a titled section, a
 * grouped bordered row container, and a title/description row — shared
 * by the plugin surfaces so section composition, density, and type
 * hierarchy stay consistent instead of being re-invented per surface.
 *
 * Type hierarchy follows the conformance baseline (docs/design/
 * conformance-audit.md §4): `text-sm` titles, `text-xs` secondary
 * copy, `text-2xs` only for badge-adjacent metadata.
 */
import type { ComponentProps, ReactNode } from "react";

import { cn } from "~/lib/utils";
import { Skeleton } from "./ui/skeleton";

/**
 * Section wrapper: `text-sm font-medium` title (T3 `h2` section header,
 * cf. UsagePage) with an optional muted description line and a
 * right-aligned action slot (refresh button, select, …).
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
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="text-sm font-medium text-foreground">{title}</h2>
          {description ? (
            <p className="text-pretty text-xs text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {action ? <div className="flex shrink-0 items-center gap-1">{action}</div> : null}
      </div>
      {children}
    </section>
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
 * idiom. Compose `Skeleton` rows instead when the shape is known.
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
 * whose content shape is a list of rows.
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
