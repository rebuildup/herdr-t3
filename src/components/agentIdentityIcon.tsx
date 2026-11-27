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
}

const RING_RADIUS = 8.75;
const RING_STROKE = {
  default: 1.5,
  attention: 2,
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
      return { tone: "text-destructive", strokeWidth: RING_STROKE.attention };
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
        "pointer-events-none absolute inset-0 size-full transition-colors duration-200",
        spec.tone,
        spec.quiet && "opacity-60",
        spec.spin && "motion-safe:visible-animate-spin",
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
  className,
  children,
}: {
  tone: "destructive" | "success" | "muted";
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        // `inset-0 m-auto` centers without a transform so the pop/exit
        // keyframes own `transform` while they run.
        "pointer-events-none absolute inset-0 m-auto flex size-3.5 items-center justify-center rounded-full text-2xs font-bold leading-none",
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
  className,
  children,
}: {
  tone: "success" | "muted";
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "pointer-events-none absolute -bottom-1 -right-1 flex size-3 items-center justify-center rounded-full text-4xs font-bold leading-none",
        tone === "success" && "bg-success text-white",
        tone === "muted" && "bg-muted-foreground/20 text-muted-foreground",
        className,
      )}
    >
      {children}
    </span>
  );
}

const MARKER_ENTER = "motion-safe:animate-marker-pop";
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
  exiting = false,
}: {
  status: AgentStatus;
  exiting?: boolean;
}) {
  const anim = exiting ? MARKER_EXIT : MARKER_ENTER;
  if (status === "blocked") {
    return (
      <StatusOverlay tone="destructive" className={anim}>
        !
      </StatusOverlay>
    );
  }
  if (status === "done") {
    return (
      <StatusBadge tone="success" className={anim}>
        <Check className="size-2" strokeWidth={3.5} />
      </StatusBadge>
    );
  }
  if (status === "idle" || status === "working") return null;
  // `unknown` and any status herdr adds later.
  return (
    <StatusBadge tone="muted" className={anim}>
      ?
    </StatusBadge>
  );
}

/**
 * Brand-led identity + status glyph for agent rows. `size-5` (20px) is the
 * shared dimension contract: the brand mark renders at `size-3` inside
 * the slot so the ring's inner edge (radius 8px) keeps readable air, and
 * Electron and GPUI must reproduce the same footprint (ui-shell.md
 * contract).
 */
export function AgentIdentityIcon({
  agent,
  status,
  className,
}: {
  agent: string | null | undefined;
  status: AgentStatus;
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
        "relative inline-flex size-5 shrink-0 items-center justify-center",
        className,
      )}
    >
      <AgentProviderIcon agent={agent} className="size-3" />
      <StatusRing status={status} />
      <StatusMarker key={status} status={status} />
      {exiting !== null && exiting !== status ? (
        <StatusMarker key={`exit-${exiting}`} status={exiting} exiting />
      ) : null}
    </span>
  );
}
