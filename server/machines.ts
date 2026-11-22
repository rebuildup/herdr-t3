/**
 * Saved SSH machine registry — herdr's own store, read-only for us.
 *
 * herdr keeps machines in `<state>/client/endpoints.json`
 * (`{version:1, ssh:[{id,label,target,session,enabled}]}`) and per-machine
 * remote metadata in `<state>/client/ssh-metadata/<id>.json`
 * (`{metadata:{os,executable}}`). State dir resolution mirrors herdr's
 * `config::state_dir`: $XDG_STATE_HOME/herdr, else ~/.local/state/herdr on
 * POSIX and %LOCALAPPDATA%\herdr on Windows.
 *
 * herdr-t3 never writes these files; `herdr machine add/remove/enable`
 * remain the only mutators.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SavedMachine {
  id: string;
  label: string;
  target: string;
  session: string;
  enabled: boolean;
}

export interface MachineMetadata {
  os?: string;
  executable?: string;
}

function stateDir(env: Record<string, string | undefined> = process.env): string {
  const xdg = env["XDG_STATE_HOME"];
  if (xdg) return join(xdg, "herdr");
  if (process.platform === "win32") {
    const local = env["LOCALAPPDATA"];
    if (local) return join(local, "herdr");
    const profile = env["USERPROFILE"];
    if (profile) return join(profile, "AppData", "Local", "herdr");
  }
  return join(env["HOME"] ?? homedir(), ".local", "state", "herdr");
}

export function endpointsPath(env: Record<string, string | undefined> = process.env): string {
  return join(stateDir(env), "client", "endpoints.json");
}

function metadataPath(machineId: string, env: Record<string, string | undefined> = process.env): string {
  return join(stateDir(env), "client", "ssh-metadata", `${machineId}.json`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse endpoints.json; returns [] when absent or malformed. */
export function loadSavedMachines(env: Record<string, string | undefined> = process.env): SavedMachine[] {
  const path = endpointsPath(env);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
  if (!isRecord(raw) || !Array.isArray(raw["ssh"])) return [];
  const machines: SavedMachine[] = [];
  for (const entry of raw["ssh"]) {
    if (!isRecord(entry)) continue;
    const { id, label, target, session, enabled } = entry;
    if (typeof id !== "string" || typeof target !== "string" || target.length === 0) continue;
    machines.push({
      id,
      label: typeof label === "string" && label.length > 0 ? label : target,
      target,
      session: typeof session === "string" && session.length > 0 ? session : "default",
      enabled: enabled !== false,
    });
  }
  return machines;
}

/** Cached remote metadata herdr recorded for this machine (os + executable). */
export function loadMachineMetadata(
  machineId: string,
  env: Record<string, string | undefined> = process.env,
): MachineMetadata | null {
  const path = metadataPath(machineId, env);
  if (!existsSync(path)) return null;
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(raw) || !isRecord(raw["metadata"])) return null;
    const meta = raw["metadata"];
    const out: MachineMetadata = {};
    if (typeof meta["os"] === "string") out.os = meta["os"];
    if (typeof meta["executable"] === "string") out.executable = meta["executable"];
    return out;
  } catch {
    return null;
  }
}
