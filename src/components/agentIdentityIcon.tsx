/*
 * Agent identity/status glyph for agent rows (issue #419, restyled under
 * #550). The left edge of an agent row is led by the brand provider mark
 * (AgentProviderIcon — T3 artwork, bundled official SVG, or the generic
 * glyph for unknown kinds) and `agent_status` is carried by a per-status
 * marker, replacing the old generic Lucide status glyph + trailing
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
 * - blocked: a warning "!" badge overlaid on the mark's top-right corner.
 * - done: a success check badge overlaid on the mark's bottom-right
 *   corner.
 * - idle: no marker — the bare brand mark is the resting state.
 * - unknown/other statuses: a muted "?" badge on the bottom-right corner
 *   — a badge (not a second ring) keeps unrecognized states distinct
 *   from idle without relying on hue.
 *
 * State meaning is never color-only: working is motion, unknown is a
 * badge glyph, blocked is warning tone + "!", and the resolved state
 * name stays in the row's hover card, section shelf and accessible name
 * (issue #381 — the name is never printed on the row).
 */
import { Check } from "lucide-react";
import type { ReactNode } from "react";

import type { AgentStatus } from "../../shared/protocol";

import { cn } from "~/lib/utils";
import { observeVisibleAnimation } from "~/lib/visibleAnimation";
import { AgentProviderIcon } from "./agentIcons";

const RING_RADIUS = 8.75;
const RING_STROKE = 1.5;

/**
 * Corner badge overlaid on the brand mark — the "!" / "?" / check
 * markers. `size-3` (12px) straddles the mark's corner: roughly a
 * quarter overlaps the glyph, the rest hangs into the row's padding.
 */
function StatusBadge({
  tone,
  corner,
  children,
}: {
  tone: "warning" | "success" | "muted";
  corner: "top-right" | "bottom-right";
  children: ReactNode;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "pointer-events-none absolute flex size-3 items-center justify-center rounded-full text-4xs font-bold leading-none",
        tone === "warning" && "bg-warning text-white",
        tone === "success" && "bg-success text-white",
        tone === "muted" && "bg-muted-foreground/20 text-muted-foreground",
        corner === "top-right" ? "-top-1 -right-1" : "-bottom-1 -right-1",
      )}
    >
      {children}
    </span>
  );
}

/**
 * The working arc — the only status that keeps the perimeter ring.
 * Motion is owned by the shared visibility control; reduced-motion
 * users get a static full ring instead.
 */
function WorkingRing() {
  return (
    <svg
      // The shared visibility control owns start/stop: the arc only runs
      // while the element is on-screen in a visible document with motion
      // allowed. Re-attaching on status change is a ref swap, not a new
      // timer — reduced-motion and backgrounded rows never animate.
      ref={observeVisibleAnimation}
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden
      className="pointer-events-none absolute inset-0 size-full text-primary motion-safe:visible-animate-spin"
    >
      {/* Reduced-motion fallback: a static full ring keeps "working"
          readable when the arc must not move (interaction.md §2). */}
      <circle
        cx="10"
        cy="10"
        r={RING_RADIUS}
        stroke="currentColor"
        strokeWidth={RING_STROKE}
        className="hidden motion-reduce:block"
      />
      <circle
        cx="10"
        cy="10"
        r={RING_RADIUS}
        stroke="currentColor"
        strokeWidth={RING_STROKE}
        strokeLinecap="round"
        pathLength={100}
        // ~30% arc — reads as a spinner segment, not a progress gauge
        // (herdr-t3 has no progress signal to map).
        strokeDasharray="30 70"
        className="motion-reduce:hidden"
      />
    </svg>
  );
}

function StatusMark({ status }: { status: AgentStatus }) {
  switch (status) {
    case "working":
      return <WorkingRing />;
    case "blocked":
      return (
        <StatusBadge tone="warning" corner="top-right">
          !
        </StatusBadge>
      );
    case "done":
      return (
        <StatusBadge tone="success" corner="bottom-right">
          <Check className="size-2" strokeWidth={3.5} />
        </StatusBadge>
      );
    case "idle":
      // The resting state needs no marker — the bare brand mark is the
      // signal, and every louder treatment stays reserved for states
      // that ask for attention.
      return null;
    default:
      // `unknown` and any status herdr adds later: a muted "?" badge so
      // unrecognized states stay visually distinct from idle.
      return (
        <StatusBadge tone="muted" corner="bottom-right">
          ?
        </StatusBadge>
      );
  }
}

/**
 * Brand-led identity + status glyph for agent rows. `size-5` (20px) is the
 * shared dimension contract: the brand mark renders at `size-3` inside
 * the slot so the working ring's inner edge (radius 8px) keeps readable
 * air, and Electron and GPUI must reproduce the same footprint
 * (ui-shell.md contract).
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
      <AgentProviderIcon agent={agent} className="size-3" />
      <StatusMark status={status} />
    </span>
  );
}
