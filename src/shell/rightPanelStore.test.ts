import { describe, expect, test } from "bun:test";

import {
  activateSurface,
  closeAllSurfaces,
  closeOtherSurfaces,
  closeSurface,
  getPanelState,
  moveSurface,
  openSurface,
  setPanelOpen,
  toggleSurface,
  type RightPanelSurface,
} from "./rightPanelStore";

const SCOPE = "local\nw1";

const projects: RightPanelSurface = { id: "projects", kind: "projects" };
const worktrees: RightPanelSurface = { id: "worktrees", kind: "worktrees" };
const gitA: RightPanelSurface = { id: "git:p1", kind: "git", paneId: "p1" };
const gitB: RightPanelSurface = { id: "git:p2", kind: "git", paneId: "p2" };

describe("rightPanelStore", () => {
  test("openSurface adds a tab, opens the panel and activates it", () => {
    const scope = `${SCOPE}:open`;
    openSurface(scope, projects);
    const state = getPanelState(scope);
    expect(state.isOpen).toBe(true);
    expect(state.surfaces.map((s) => s.id)).toEqual(["projects"]);
    expect(state.activeSurfaceId).toBe("projects");
  });

  test("re-opening an existing surface activates without duplicating", () => {
    const scope = `${SCOPE}:dedupe`;
    openSurface(scope, projects);
    openSurface(scope, worktrees);
    openSurface(scope, projects);
    const state = getPanelState(scope);
    expect(state.surfaces.map((s) => s.id)).toEqual(["projects", "worktrees"]);
    expect(state.activeSurfaceId).toBe("projects");
  });

  test("re-opening refreshes the payload in place (checkpoints pane)", () => {
    const scope = `${SCOPE}:payload`;
    openSurface(scope, { id: "checkpoints", kind: "checkpoints", paneId: "p1" });
    openSurface(scope, { id: "checkpoints", kind: "checkpoints", paneId: "p2" });
    const state = getPanelState(scope);
    expect(state.surfaces).toHaveLength(1);
    expect(state.surfaces[0]).toMatchObject({ paneId: "p2" });
  });

  test("activateSurface only targets existing surfaces", () => {
    const scope = `${SCOPE}:activate`;
    openSurface(scope, projects);
    activateSurface(scope, "missing");
    expect(getPanelState(scope).activeSurfaceId).toBe("projects");
    activateSurface(scope, "projects");
    expect(getPanelState(scope).isOpen).toBe(true);
  });

  test("closeSurface removes the tab and re-activates a neighbor", () => {
    const scope = `${SCOPE}:close`;
    openSurface(scope, projects);
    openSurface(scope, worktrees);
    openSurface(scope, gitA);
    closeSurface(scope, "worktrees");
    let state = getPanelState(scope);
    expect(state.surfaces.map((s) => s.id)).toEqual(["projects", "git:p1"]);
    expect(state.activeSurfaceId).toBe("git:p1");
    closeSurface(scope, "git:p1");
    state = getPanelState(scope);
    expect(state.surfaces.map((s) => s.id)).toEqual(["projects"]);
    expect(state.activeSurfaceId).toBe("projects");
  });

  test("closing the last surface clears the scope", () => {
    const scope = `${SCOPE}:last`;
    openSurface(scope, projects);
    closeSurface(scope, "projects");
    expect(getPanelState(scope).surfaces).toHaveLength(0);
  });

  test("closeOtherSurfaces keeps only the target", () => {
    const scope = `${SCOPE}:others`;
    openSurface(scope, projects);
    openSurface(scope, worktrees);
    openSurface(scope, gitA);
    closeOtherSurfaces(scope, "worktrees");
    const state = getPanelState(scope);
    expect(state.surfaces.map((s) => s.id)).toEqual(["worktrees"]);
    expect(state.activeSurfaceId).toBe("worktrees");
  });

  test("moveSurface reorders with post-removal indexing", () => {
    const scope = `${SCOPE}:move`;
    openSurface(scope, projects);
    openSurface(scope, worktrees);
    openSurface(scope, gitA);
    // Move first tab after the last: drop insert index 3 -> adjusted 2.
    moveSurface(scope, "projects", 2);
    expect(getPanelState(scope).surfaces.map((s) => s.id)).toEqual([
      "worktrees",
      "git:p1",
      "projects",
    ]);
    // Move last tab back to front.
    moveSurface(scope, "projects", 0);
    expect(getPanelState(scope).surfaces.map((s) => s.id)).toEqual([
      "projects",
      "worktrees",
      "git:p1",
    ]);
  });

  test("toggleSurface closes an open surface and opens a closed one", () => {
    const scope = `${SCOPE}:toggle`;
    toggleSurface(scope, projects);
    expect(getPanelState(scope).surfaces.map((s) => s.id)).toEqual(["projects"]);
    toggleSurface(scope, projects);
    expect(getPanelState(scope).surfaces).toHaveLength(0);
    toggleSurface(scope, gitB);
    expect(getPanelState(scope).surfaces.map((s) => s.id)).toEqual(["git:p2"]);
  });

  test("setPanelOpen hides without discarding surfaces", () => {
    const scope = `${SCOPE}:hide`;
    openSurface(scope, projects);
    setPanelOpen(scope, false);
    let state = getPanelState(scope);
    expect(state.isOpen).toBe(false);
    expect(state.surfaces).toHaveLength(1);
    openSurface(scope, worktrees);
    state = getPanelState(scope);
    expect(state.isOpen).toBe(true);
  });

  test("closeAllSurfaces resets the scope", () => {
    const scope = `${SCOPE}:all`;
    openSurface(scope, projects);
    openSurface(scope, worktrees);
    closeAllSurfaces(scope);
    expect(getPanelState(scope).surfaces).toHaveLength(0);
    expect(getPanelState(scope).isOpen).toBe(false);
  });

  test("automations surface opens like other workspace-scoped surfaces", () => {
    const scope = `${SCOPE}:automations`;
    openSurface(scope, { id: "automations", kind: "automations" });
    const state = getPanelState(scope);
    expect(state.isOpen).toBe(true);
    expect(state.surfaces.map((s) => s.id)).toEqual(["automations"]);
    expect(state.activeSurfaceId).toBe("automations");
    toggleSurface(scope, { id: "automations", kind: "automations" });
    expect(getPanelState(scope).surfaces).toHaveLength(0);
  });

  test("conversations surface opens like other workspace-scoped surfaces", () => {
    const scope = `${SCOPE}:conversations`;
    openSurface(scope, { id: "conversations", kind: "conversations" });
    const state = getPanelState(scope);
    expect(state.isOpen).toBe(true);
    expect(state.surfaces.map((s) => s.id)).toEqual(["conversations"]);
    expect(state.activeSurfaceId).toBe("conversations");
    toggleSurface(scope, { id: "conversations", kind: "conversations" });
    expect(getPanelState(scope).surfaces).toHaveLength(0);
  });

  test("usage surface opens like other workspace-scoped surfaces", () => {
    const scope = `${SCOPE}:usage`;
    openSurface(scope, { id: "usage", kind: "usage" });
    const state = getPanelState(scope);
    expect(state.isOpen).toBe(true);
    expect(state.surfaces.map((s) => s.id)).toEqual(["usage"]);
    expect(state.activeSurfaceId).toBe("usage");
    toggleSurface(scope, { id: "usage", kind: "usage" });
    expect(getPanelState(scope).surfaces).toHaveLength(0);
  });

  test("artifacts surface opens like other workspace-scoped surfaces", () => {
    const scope = `${SCOPE}:artifacts`;
    openSurface(scope, { id: "artifacts", kind: "artifacts" });
    const state = getPanelState(scope);
    expect(state.isOpen).toBe(true);
    expect(state.surfaces.map((s) => s.id)).toEqual(["artifacts"]);
    expect(state.activeSurfaceId).toBe("artifacts");
    toggleSurface(scope, { id: "artifacts", kind: "artifacts" });
    expect(getPanelState(scope).surfaces).toHaveLength(0);
  });

  test("handoffs surface opens like other workspace-scoped surfaces", () => {
    const scope = `${SCOPE}:handoffs`;
    openSurface(scope, { id: "handoffs", kind: "handoffs" });
    const state = getPanelState(scope);
    expect(state.isOpen).toBe(true);
    expect(state.surfaces.map((s) => s.id)).toEqual(["handoffs"]);
    expect(state.activeSurfaceId).toBe("handoffs");
    toggleSurface(scope, { id: "handoffs", kind: "handoffs" });
    expect(getPanelState(scope).surfaces).toHaveLength(0);
  });

  test("textgen surface opens like other workspace-scoped surfaces", () => {
    const scope = `${SCOPE}:textgen`;
    openSurface(scope, { id: "textgen", kind: "textgen" });
    const state = getPanelState(scope);
    expect(state.isOpen).toBe(true);
    expect(state.surfaces.map((s) => s.id)).toEqual(["textgen"]);
    expect(state.activeSurfaceId).toBe("textgen");
    toggleSurface(scope, { id: "textgen", kind: "textgen" });
    expect(getPanelState(scope).surfaces).toHaveLength(0);
  });

  test("secrets surface opens like other workspace-scoped surfaces", () => {
    const scope = `${SCOPE}:secrets`;
    openSurface(scope, { id: "secrets", kind: "secrets" });
    const state = getPanelState(scope);
    expect(state.isOpen).toBe(true);
    expect(state.surfaces.map((s) => s.id)).toEqual(["secrets"]);
    expect(state.activeSurfaceId).toBe("secrets");
    toggleSurface(scope, { id: "secrets", kind: "secrets" });
    expect(getPanelState(scope).surfaces).toHaveLength(0);
  });

  test("machines surface opens like other workspace-scoped surfaces", () => {
    const scope = `${SCOPE}:machines`;
    openSurface(scope, { id: "machines", kind: "machines" });
    const state = getPanelState(scope);
    expect(state.isOpen).toBe(true);
    expect(state.surfaces.map((s) => s.id)).toEqual(["machines"]);
    expect(state.activeSurfaceId).toBe("machines");
    toggleSurface(scope, { id: "machines", kind: "machines" });
    expect(getPanelState(scope).surfaces).toHaveLength(0);
  });

  test("mcp surface opens like other workspace-scoped surfaces", () => {
    const scope = `${SCOPE}:mcp`;
    openSurface(scope, { id: "mcp", kind: "mcp" });
    const state = getPanelState(scope);
    expect(state.isOpen).toBe(true);
    expect(state.surfaces.map((s) => s.id)).toEqual(["mcp"]);
    expect(state.activeSurfaceId).toBe("mcp");
    toggleSurface(scope, { id: "mcp", kind: "mcp" });
    expect(getPanelState(scope).surfaces).toHaveLength(0);
  });

  test("scopes are independent", () => {
    const a = `${SCOPE}:a`;
    const b = `${SCOPE}:b`;
    openSurface(a, projects);
    openSurface(b, worktrees);
    expect(getPanelState(a).surfaces.map((s) => s.id)).toEqual(["projects"]);
    expect(getPanelState(b).surfaces.map((s) => s.id)).toEqual(["worktrees"]);
  });
});
