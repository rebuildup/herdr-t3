/*
 * Minimal typed localStorage helpers replacing t3code's Schema-validated
 * useLocalStorage (herdr-t3 does not depend on effect). Values are stored as
 * JSON, matching the upstream encoding.
 */

function storage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function getLocalStorageNumber(key: string): number | null {
  const raw = storage()?.getItem(key);
  if (raw === null || raw === undefined) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

export function setLocalStorageNumber(key: string, value: number): void {
  try {
    storage()?.setItem(key, String(value));
  } catch {
    /* storage unavailable */
  }
}

export function getLocalStorageBoolean(key: string): boolean | null {
  const raw = storage()?.getItem(key);
  if (raw === "true") return true;
  if (raw === "false") return false;
  return null;
}

export function setLocalStorageBoolean(key: string, value: boolean): void {
  try {
    storage()?.setItem(key, value ? "true" : "false");
  } catch {
    /* storage unavailable */
  }
}

export function removeLocalStorageItem(key: string): void {
  try {
    storage()?.removeItem(key);
  } catch {
    /* storage unavailable */
  }
}
