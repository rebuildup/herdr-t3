/**
 * Observation comparator (issue #237). Two modes:
 *  - "exact": deep equality after normalization (default for encoded
 *    bytes and decoded frames — order and content both matter)
 *  - "subset": expected is a recursive subset of observed (for large
 *    screen snapshots where only asserted cells matter)
 * Arrays always compare element-wise and in order; a length mismatch is
 * a failure in both modes.
 */

export interface CompareResult {
  ok: boolean;
  diffs: string[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function compareExact(expected: unknown, observed: unknown, path: string, diffs: string[]): void {
  if (Array.isArray(expected)) {
    if (!Array.isArray(observed)) {
      diffs.push(`${path}: expected array, got ${JSON.stringify(observed)}`);
      return;
    }
    if (expected.length !== observed.length) {
      diffs.push(`${path}: array length ${expected.length} != ${observed.length}`);
      return;
    }
    for (let i = 0; i < expected.length; i++) {
      compareExact(expected[i], observed[i], `${path}[${i}]`, diffs);
    }
    return;
  }
  if (isPlainObject(expected)) {
    if (!isPlainObject(observed)) {
      diffs.push(`${path}: expected object, got ${JSON.stringify(observed)}`);
      return;
    }
    for (const [k, v] of Object.entries(expected)) {
      if (!(k in observed)) {
        diffs.push(`${path}.${k}: missing in observed`);
      } else {
        compareExact(v, observed[k], `${path}.${k}`, diffs);
      }
    }
    for (const k of Object.keys(observed)) {
      if (!(k in expected)) diffs.push(`${path}.${k}: unexpected in observed`);
    }
    return;
  }
  if (expected !== observed) {
    diffs.push(`${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(observed)}`);
  }
}

function compareSubset(expected: unknown, observed: unknown, path: string, diffs: string[]): void {
  if (isPlainObject(expected)) {
    if (!isPlainObject(observed)) {
      diffs.push(`${path}: expected object, got ${JSON.stringify(observed)}`);
      return;
    }
    for (const [k, v] of Object.entries(expected)) {
      if (!(k in observed)) {
        diffs.push(`${path}.${k}: missing in observed`);
      } else {
        compareSubset(v, observed[k], `${path}.${k}`, diffs);
      }
    }
    return;
  }
  if (Array.isArray(expected)) {
    // Subset arrays still require same length and order — partial arrays
    // would hide missing/duplicated elements (ordering is semantic).
    compareExact(expected, observed, path, diffs);
    return;
  }
  if (expected !== observed) {
    diffs.push(`${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(observed)}`);
  }
}

export function compare(expect: unknown, observed: unknown, match: "subset" | "exact" = "exact"): CompareResult {
  const diffs: string[] = [];
  if (match === "exact") compareExact(expect, observed, "$", diffs);
  else compareSubset(expect, observed, "$", diffs);
  return { ok: diffs.length === 0, diffs };
}
