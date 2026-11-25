/** Path helpers for "a.b.0.c" style paths into JSON values. */
export function getPath(value: unknown, path: string): unknown {
  let cur = value;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let cur = target;
  for (const part of parts.slice(0, -1)) {
    const next = cur[part];
    if (next === null || typeof next !== "object") {
      cur[part] = {};
    }
    cur = cur[part] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
}

export function deletePath(value: unknown, path: string): void {
  const parts = path.split(".");
  const parent = getPath(value, parts.slice(0, -1).join("."));
  if (parent !== null && typeof parent === "object") {
    delete (parent as Record<string, unknown>)[parts[parts.length - 1]!];
  }
}

/** Deep clone through JSON so observations are plain data. */
export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
