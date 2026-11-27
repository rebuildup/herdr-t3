import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { AgentStatus } from "../../shared/protocol";
import { AgentIdentityIcon } from "./agentIdentityIcon";

// Issue #419, restyled under #550: the agent row's left edge is one
// shared identity/status glyph — brand mark led, agent_status carried by
// a per-status marker. Working keeps the perimeter arc; blocked/done/
// unknown get corner badges; idle is the bare mark. These tests pin the
// marker grammar and the brand-asset passthrough for known, svg,
// generic and unknown kinds.

function render(agent: string | null | undefined, status: AgentStatus): string {
  return renderToStaticMarkup(<AgentIdentityIcon agent={agent} status={status} />);
}

describe("AgentIdentityIcon", () => {
  test("every status renders the brand mark", () => {
    const statuses: AgentStatus[] = [
      "working",
      "blocked",
      "done",
      "idle",
      "unknown",
      "some-future-status",
    ];
    for (const status of statuses) {
      const html = render("claude", status);
      // claude is a t3 brand spec → inline svg paths inside the glyph.
      expect(html, status).toContain("<path");
      expect(html, status).toContain('aria-hidden="true"');
    }
  });

  test("working renders a spinning primary arc with a reduced-motion fallback ring", () => {
    const html = render("claude", "working");
    expect(html).toContain("visible-animate-spin");
    expect(html).toContain("motion-safe:visible-animate-spin");
    expect(html).toContain("text-primary");
    // ~30% arc on a pathLength=100 circle, round cap.
    expect(html).toContain('stroke-dasharray="30 70"');
    expect(html).toContain('stroke-linecap="round"');
    // Static full ring shown only under prefers-reduced-motion.
    expect(html).toContain("motion-reduce:block");
    expect(html).toContain("motion-reduce:hidden");
  });

  test("non-working statuses never carry the spin animation or the ring", () => {
    for (const status of ["blocked", "done", "idle", "unknown"] as const) {
      const html = render("claude", status);
      expect(html, status).not.toContain("visible-animate-spin");
      expect(html, status).not.toContain("motion-reduce:block");
      expect(html, status).not.toContain("stroke-dasharray");
    }
  });

  test("status markers follow the badge grammar", () => {
    // blocked → warning "!" badge on the top-right corner.
    const blocked = render("claude", "blocked");
    expect(blocked).toContain("bg-warning");
    expect(blocked).toContain("-top-1");
    expect(blocked).toContain(">!</span>");
    // done → success check badge on the bottom-right corner.
    const done = render("claude", "done");
    expect(done).toContain("bg-success");
    expect(done).toContain("-bottom-1");
    expect(done).toContain("lucide-check");
    // idle → bare brand mark, no marker at all.
    const idle = render("claude", "idle");
    expect(idle).not.toContain("bg-warning");
    expect(idle).not.toContain("bg-success");
    expect(idle).not.toContain("bg-muted-foreground/20");
    // claude's brand mark is the only svg left for idle.
    expect(idle.match(/<svg/g)?.length).toBe(1);
    // Unknown and unrecognized statuses share the muted "?" badge.
    for (const status of ["unknown", "some-future-status"] as const) {
      const html = render("claude", status);
      expect(html, status).toContain("bg-muted-foreground/20");
      expect(html, status).toContain("-bottom-1");
      expect(html, status).toContain(">?</span>");
    }
  });

  test("brand resolution is unchanged: t3 spec, bundled svg, generic fallback", () => {
    // t3 artwork → inline svg paths, no <img>.
    const t3 = render("claude", "idle");
    expect(t3).toContain("<path");
    expect(t3).not.toContain("<img");
    // Bundled official svg → recolored <img> asset.
    const svg = render("devin", "idle");
    expect(svg).toContain("<img");
    expect(svg).toContain("object-contain");
    // Unknown kinds and prototype-spelled labels → generic Bot glyph.
    for (const agent of ["not-a-kind", "constructor", null, undefined]) {
      const html = render(agent, "idle");
      expect(html, String(agent)).toContain("lucide-bot");
      expect(html, String(agent)).not.toContain("<img");
    }
  });
});
