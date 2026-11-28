/*
 * Agent identity/status glyph for agent rows (issue #419, restyled under
 * #550). The left edge of an agent row is led by the brand provider mark
 * (AgentProviderIcon — T3 artwork, bundled official SVG, or the generic
 * glyph for unknown kinds) inside a perimeter status ring, and
 * `agent_status` adds a centered overlay marker where the state asks for
 * attention — replacing the old generic Lucide status glyph + trailing
 * size-3 brand icon pair.
 *
 * Marker grammar (shared with the GPUI renderer via docs/migration/
 * contracts/ui-shell.md — same assets, same state mapping, same sizes):
 *
 * - working: a primary arc rotates around the static brand mark. Only the
 *   ring moves; the brand SVG never spins. The arc runs through
 *   `visible-animate-spin` + `observeVisibleAnimation` (the shared
 *   visibility control, issue #381) so it stops when the row is
 *   off-screen, the document is hidden, or motion is reduced — the same
 *   control the Windows animation-stop investigation (#420) audits; no
 *   separate timer exists here. Under `prefers-reduced-motion` a static
 *   full primary ring keeps the state readable.
 * - blocked: destructive ring at a heavier stroke plus a centered red
 *   "!" disc large enough to cover the brand mark.
 * - done: success ring plus a small success check badge on the
 *   bottom-right corner.
 * - idle: quiet solid muted ring, no marker — the resting state.
 * - unknown/other statuses: dashed muted ring plus a small muted "?"
 *   badge on the bottom-right corner — dashed vs solid and the muted
 *   tone keep unrecognized states distinct from idle without relying
 *   on hue.
 *
 * State meaning is never color-only: working is motion, unknown is a
 * dash pattern + "?", blocked is stroke weight + "!", and the resolved
 * state name stays in the row's hover card, section shelf and
 * accessible name (issue #381 — the name is never printed on the row).
 */
import { Check } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import type { AgentStatus } from "../../shared/protocol";

import { cn } from "~/lib/utils";
import { observeVisibleAnimation } from "~/lib/visibleAnimation";
import { AgentProviderIcon } from "./agentIcons";

interface StatusRingSpec {
  /** `currentColor` tone utility applied to the ring svg. */
  tone: string;
  strokeWidth: number;
  /**
   * `stroke-dasharray` on a `pathLength={100}` circle; undefined renders
   * a solid ring. Used by the working arc and the unknown dash pattern.
   */
  dasharray?: string;
  /** Rotating arc — only the working ring animates. */
  spin?: boolean;
  /** Dim the ring for states that should not compete for attention. */
  quiet?: boolean;
  /** Slow opacity breathing for states that must keep asking. */
  pulse?: boolean;
}

const RING_RADIUS = 8.75;
const RING_STROKE = {
  default: 1.5,
  attention: 2,
} as const;

/**
 * Two densities of the same grammar plus a promo size: `md` (20px)
 * leads agent rows; `sm` (16px) fits dense chrome — tab pills, goto
 * rows, detail rows; `lg` (24px) fronts notification toasts where the
 * glyph is the surface's primary signal. The ring is vector (viewBox
 * scales); mark, markers and type sizes scale with the slot.
 */
export type AgentIconSize = "md" | "sm" | "lg";

const GLYPH = {
  md: {
    slot: "size-5",
    mark: "size-3",
    overlay: "size-3.5 text-2xs",
    badge: "size-3 -bottom-1 -right-1 text-4xs",
    check: "size-2",
  },
  sm: {
    slot: "size-4",
    mark: "size-2.5",
    overlay: "size-3 text-3xs",
    badge: "size-2.5 -bottom-0.5 -right-0.5 text-5xs",
    check: "size-1.5",
  },
  lg: {
    slot: "size-6",
    mark: "size-3.5",
    overlay: "size-4 text-xs",
    badge: "size-3.5 -bottom-1 -right-1 text-3xs",
    check: "size-2.5",
  },
} as const;

function statusRingSpec(status: AgentStatus): StatusRingSpec {
  switch (status) {
    case "working":
      return {
        tone: "text-primary",
        strokeWidth: RING_STROKE.default,
        // ~30% arc with a round cap — reads as a spinner segment, not a
        // progress gauge (herdr-t3 has no progress signal to map).
        dasharray: "30 70",
        spin: true,
      };
    case "blocked":
      return {
        tone: "text-destructive",
        strokeWidth: RING_STROKE.attention,
        pulse: true,
      };
    case "done":
      return { tone: "text-success", strokeWidth: RING_STROKE.default };
    case "idle":
      return {
        tone: "text-muted-foreground",
        strokeWidth: RING_STROKE.default,
        quiet: true,
      };
    default:
      // `unknown` and any status herdr adds later: dashed muted ring so
      // unrecognized states stay visually distinct from idle.
      return {
        tone: "text-muted-foreground",
        strokeWidth: RING_STROKE.default,
        dasharray: "5 5",
        quiet: true,
      };
  }
}

function StatusRing({ status }: { status: AgentStatus }) {
  const spec = statusRingSpec(status);
  return (
    <svg
      // The shared visibility control owns start/stop: the arc only runs
      // while the element is on-screen in a visible document with motion
      // allowed. Re-attaching on status change is a ref swap, not a new
      // timer — reduced-motion and backgrounded rows never animate.
      ref={spec.spin ? observeVisibleAnimation : undefined}
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden
      className={cn(
        // `agent-ring` hooks the hover swell in index.css; color,
        // stroke-width and opacity all transition on motion tokens.
        "agent-ring pointer-events-none absolute inset-0 size-full",
        spec.tone,
        spec.quiet && "opacity-60",
        spec.spin && "motion-safe:visible-animate-spin",
        spec.pulse && "motion-safe:animate-pulse",
      )}
    >
      {spec.spin ? (
        <>
          {/* Reduced-motion fallback: a static full ring keeps "working"
              readable when the arc must not move (interaction.md §2). */}
          <circle
            cx="10"
            cy="10"
            r={RING_RADIUS}
            stroke="currentColor"
            strokeWidth={spec.strokeWidth}
            className="hidden motion-reduce:block"
          />
          <circle
            cx="10"
            cy="10"
            r={RING_RADIUS}
            stroke="currentColor"
            strokeWidth={spec.strokeWidth}
            strokeLinecap="round"
            pathLength={100}
            strokeDasharray={spec.dasharray}
            className="motion-reduce:hidden"
          />
        </>
      ) : (
        <circle
          cx="10"
          cy="10"
          r={RING_RADIUS}
          stroke="currentColor"
          strokeWidth={spec.strokeWidth}
          pathLength={100}
          strokeDasharray={spec.dasharray}
        />
      )}
    </svg>
  );
}

/**
 * Centered overlay disc — an independent layer above the mark and the
 * ring, not a flex sibling: as a flow child it would sit beside the
 * brand mark and squeeze the 20px slot. Large enough to hide the mark
 * so the state reads at a glance instead of competing with the glyph
 * for attention.
 */
function StatusOverlay({
  tone,
  size,
  className,
  children,
}: {
  tone: "destructive" | "success" | "muted";
  size: AgentIconSize;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        // `inset-0 m-auto` centers without a transform so the pop/exit
        // keyframes own `transform` while they run.
        "pointer-events-none absolute inset-0 m-auto flex items-center justify-center rounded-full font-bold leading-none",
        GLYPH[size].overlay,
        tone === "destructive" && "bg-destructive text-white",
        tone === "success" && "bg-success text-white",
        tone === "muted" && "bg-muted-foreground text-background",
        className,
      )}
    >
      {children}
    </span>
  );
}

/**
 * Small corner badge — the quiet markers (done check, unknown "?").
 * `size-3` (12px) straddles the mark's bottom-right corner: roughly a
 * quarter overlaps the glyph, the rest hangs into the row's padding.
 * Absolutely positioned so it layers over the mark and ring without
 * squeezing the slot.
 */
function StatusBadge({
  tone,
  size,
  className,
  children,
}: {
  tone: "success" | "muted";
  size: AgentIconSize;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "pointer-events-none absolute flex items-center justify-center rounded-full font-bold leading-none",
        GLYPH[size].badge,
        tone === "success" && "bg-success text-white",
        tone === "muted" && "bg-muted-foreground/20 text-muted-foreground",
        className,
      )}
    >
      {children}
    </span>
  );
}

const MARKER_ENTER_BLOCKED = "motion-safe:animate-marker-blocked";
const MARKER_ENTER_LIVE = "motion-safe:animate-marker-live";
const MARKER_EXIT = "motion-safe:animate-marker-exit";
/** Matches `--animate-marker-exit` duration plus a small buffer. */
const MARKER_EXIT_MS = 180;

/**
 * The per-status marker layer (overlay disc or corner badge). `key`ed
 * by status at the call site so every transition remounts and replays
 * the pop; `exiting` clones fade out instead.
 */
function StatusMarker({
  status,
  size,
  exiting = false,
}: {
  status: AgentStatus;
  size: AgentIconSize;
  exiting?: boolean;
}) {
  const check = <Check className={GLYPH[size].check} strokeWidth={3.5} />;
  if (exiting) {
    // The outgoing marker only fades — its ongoing motion stops with it.
    return status === "blocked" ? (
      <StatusOverlay tone="destructive" size={size} className={MARKER_EXIT}>
        !
      </StatusOverlay>
    ) : status === "done" ? (
      <StatusBadge tone="success" size={size} className={MARKER_EXIT}>
        {check}
      </StatusBadge>
    ) : status === "idle" || status === "working" ? null : (
      <StatusBadge tone="muted" size={size} className={MARKER_EXIT}>
        ?
      </StatusBadge>
    );
  }
  if (status === "blocked") {
    return (
      <StatusOverlay tone="destructive" size={size} className={MARKER_ENTER_BLOCKED}>
        !
      </StatusOverlay>
    );
  }
  if (status === "done") {
    return (
      <StatusBadge tone="success" size={size} className={MARKER_ENTER_LIVE}>
        {check}
      </StatusBadge>
    );
  }
  if (status === "idle" || status === "working") return null;
  // `unknown` and any status herdr adds later.
  return (
    <StatusBadge tone="muted" size={size} className={MARKER_ENTER_LIVE}>
      ?
    </StatusBadge>
  );
}

/**
 * Brand-led identity + status glyph for agent rows. `md` (`size-5`,
 * 20px) is the shared dimension contract: the brand mark renders at
 * `size-3` inside the slot so the ring's inner edge (radius 8px) keeps
 * readable air, and Electron and GPUI must reproduce the same
 * footprint (ui-shell.md contract). `sm` (`size-4`, 16px) is the same
 * grammar at dense-chrome density — tab pills, goto rows, detail rows.
 * `lg` (`size-6`, 24px) is the promo density for notification toasts.
 */
export function AgentIdentityIcon({
  agent,
  status,
  size = "md",
  className,
}: {
  agent: string | null | undefined;
  status: AgentStatus;
  /** `md` (20px) for agent rows, `sm` (16px) for dense chrome, `lg` (24px) for toasts. */
  size?: AgentIconSize;
  className?: string;
}) {
  // Status transitions animate: the incoming marker pops in while the
  // outgoing one fades out for MARKER_EXIT_MS. The ring needs no clone —
  // its color transitions via `transition-colors` on the same element.
  const [exiting, setExiting] = useState<AgentStatus | null>(null);
  const prevStatus = useRef(status);
  useEffect(() => {
    if (prevStatus.current === status) return;
    const old = prevStatus.current;
    prevStatus.current = status;
    setExiting(old);
    const timer = window.setTimeout(() => setExiting(null), MARKER_EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [status]);
  return (
    <span
      className={cn(
        // `agent-identity` hooks the hover lift + ring swell in
        // index.css.
        "agent-identity relative inline-flex shrink-0 items-center justify-center",
        GLYPH[size].slot,
        className,
      )}
    >
      <AgentProviderIcon agent={agent} className={GLYPH[size].mark} />
      <StatusRing status={status} />
      <StatusMarker key={status} status={status} size={size} />
      {exiting !== null && exiting !== status ? (
        <StatusMarker key={`exit-${exiting}`} status={exiting} size={size} exiting />
      ) : null}
    </span>
  );
}
