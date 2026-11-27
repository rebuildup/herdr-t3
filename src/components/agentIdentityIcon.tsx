/*
 * Agent identity/status glyph for agent rows (issue #419). The left edge
 * of an agent row is led by the brand provider mark (AgentProviderIcon —
 * T3 artwork, bundled official SVG, or the generic glyph for unknown
 * kinds) and a perimeter status ring carries `agent_status`, replacing
 * the old generic Lucide status glyph + trailing size-3 brand icon pair.
 *
 * Ring grammar (shared with the GPUI renderer via docs/migration/
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
 * - blocked: solid warning ring at a heavier stroke — the attention
 *   state stays loud without a second glyph.
 * - done: solid success ring.
 * - idle: quiet solid muted ring.
 * - unknown/other statuses: dashed muted ring — dashed vs solid and the
 *   muted tone keep it distinct from idle without relying on hue.
 *
 * State meaning is never color-only: working is motion, unknown is a
 * dash pattern, blocked is stroke weight, and the resolved state name
 * stays in the row's hover card, section shelf and accessible name
 * (issue #381 — the name is never printed on the row).
 */
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
      return { tone: "text-warning", strokeWidth: RING_STROKE.attention };
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
        "pointer-events-none absolute inset-0 size-full",
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
 * Brand-led identity + status glyph for agent rows. `size-5` (20px) is the
 * shared dimension contract: the brand mark renders at `size-3.5` inside
 * the slot and the ring's viewBox is 20 units, so Electron and GPUI must
 * reproduce the same footprint (ui-shell.md contract). The 16px mark left
 * zero clearance to the ring's inner edge — the two touched.
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
  return (
    <span
      className={cn(
        "relative inline-flex size-5 shrink-0 items-center justify-center",
        className,
      )}
    >
      <AgentProviderIcon agent={agent} className="size-3.5" />
      <StatusRing status={status} />
    </span>
  );
}
