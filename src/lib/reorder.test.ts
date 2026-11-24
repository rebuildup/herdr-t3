import { describe, expect, it } from "bun:test";
import { moveInsertIndex } from "./reorder.ts";

// The contract both drag surfaces (workspace list, tab strip) rely on:
// herdr `insert_index` is a pre-removal insertion point, and dropping an
// item onto itself or its immediate successor is a no-op — firing the RPC
// anyway would make herdr reorder the list under the user's cursor.
describe("moveInsertIndex", () => {
  it("maps before/after halves of the target to pre-removal indices", () => {
    // 5 items, drag index 0 onto target index 3
    expect(moveInsertIndex(0, 3, "before")).toBe(3);
    expect(moveInsertIndex(0, 3, "after")).toBe(4);
    // appending past the last index is `length` — callers pass the raw index
    expect(moveInsertIndex(0, 4, "after")).toBe(5);
  });

  it("is a no-op when the drop lands where the item already sits", () => {
    // dropping before itself, or after itself (to === from + 1)
    expect(moveInsertIndex(2, 2, "before")).toBeNull();
    expect(moveInsertIndex(2, 2, "after")).toBeNull();
    expect(moveInsertIndex(2, 3, "before")).toBeNull(); // already right before index 3
    // C (index 2) dropped after B (index 1) already sits there — no-op
    expect(moveInsertIndex(2, 1, "after")).toBeNull();
    // a real move one slot left is not a no-op
    expect(moveInsertIndex(2, 1, "before")).toBe(1);
    expect(moveInsertIndex(2, 0, "after")).toBe(1);
  });

  it("moves an item across the list in both directions", () => {
    // drag last onto first
    expect(moveInsertIndex(4, 0, "before")).toBe(0);
    // drag first onto last
    expect(moveInsertIndex(0, 4, "before")).toBe(4);
  });
});
