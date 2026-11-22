/**
 * Machine manager (ADR-0006, issue #31).
 *
 * Owns one BridgeSession per connectable herdr endpoint: `local` (this
 * machine's socket) plus every enabled entry in herdr's saved-machine
 * registry. Machine-scoped ClientFrames are routed by `machine`; endpoint
 * ServerFrames are tagged with their machine id so pane/workspace ids from
 * different machines can never be mixed.
 *
 * Status lifecycle per machine: connecting -> online | auth_required |
 * incompatible | unreachable | error | offline. Sessions connect lazily on
 * first use or explicit machine_connect; a periodic refresh re-reads
 * herdr's endpoints.json so `herdr machine add/remove` is picked up.
 */
import { spawn } from "node:child_process";
import type { ClientFrame, MachineInfo, MachineStatus, ServerFrame } from "../shared/protocol.ts";
import { createBridgeSession, fetchSnapshot, localEndpoint, type BridgeEndpoint, type BridgeSession } from "./bridge-core.ts";
import { loadMachineMetadata, loadSavedMachines, type SavedMachine } from "./machines.ts";
import {
  classifySshFailure,
  endpointFromMachine,
  resolveRemoteHerdr,
  sshApiConnector,
  sshClientConnector,
  type SshEndpoint,
} from "./ssh.ts";

const LOCAL_ID = "local";
const REFRESH_INTERVAL_MS = 60_000;
const MACHINE_ADD_TIMEOUT_MS = 120_000;

interface ManagedSession {
  session: BridgeSession;
  endpoint?: BridgeEndpoint;
}

export interface MachineManagerOptions {
  send: (frame: ServerFrame) => void;
  /** Override for tests: machine list source. */
  listMachines?: () => SavedMachine[];
}

export class MachineManager {
  private readonly send: (frame: ServerFrame) => void;
  private readonly listSource: () => SavedMachine[];
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly infos = new Map<string, MachineInfo>();
  private readonly resolving = new Map<string, Promise<void>>();
  /** Frames received for a machine whose session is still connecting. */
  private readonly pendingFrames = new Map<string, ClientFrame[]>();
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(options: MachineManagerOptions) {
    this.send = options.send;
    this.listSource = options.listMachines ?? (() => loadSavedMachines());
    this.infos.set(LOCAL_ID, {
      id: LOCAL_ID,
      label: "Local",
      kind: "local",
      enabled: true,
      status: "connecting",
    });
    // Local session is always up; it owns the pre-existing behavior.
    this.ensureLocal();
  }

  /* ---------------------------- public API ---------------------------- */

  list(): MachineInfo[] {
    return [...this.infos.values()];
  }

  /** Push the full machine list to the consumer. */
  pushMachines(): void {
    this.send({ type: "machines", machines: this.list() });
  }

  /** Re-read herdr's registry, drop vanished machines, refresh statuses. */
  async refresh(): Promise<void> {
    if (this.closed) return;
    const saved = this.listSource();
    const seen = new Set<string>([LOCAL_ID]);
    for (const machine of saved) {
      seen.add(machine.id);
      const existing = this.infos.get(machine.id);
      if (existing) {
        existing.label = machine.label;
        existing.target = machine.target;
        existing.session = machine.session;
        existing.enabled = machine.enabled;
        if (!machine.enabled && this.sessions.has(machine.id)) {
          this.disconnect(machine.id);
          existing.status = "disabled";
        }
      } else {
        this.infos.set(machine.id, {
          id: machine.id,
          label: machine.label,
          kind: "ssh",
          target: machine.target,
          session: machine.session,
          enabled: machine.enabled,
          status: machine.enabled ? "offline" : "disabled",
        });
      }
    }
    for (const id of [...this.sessions.keys()]) {
      if (!seen.has(id)) this.disconnect(id);
    }
    for (const id of [...this.infos.keys()]) {
      if (!seen.has(id)) this.infos.delete(id);
    }
    this.pushMachines();
    // Probe machines that have no live session so the list shows real
    // reachability, not just "offline".
    for (const info of this.list()) {
      if (info.kind === "ssh" && info.enabled && !this.sessions.has(info.id) && info.status !== "disabled") {
        void this.probe(info.id);
      }
    }
  }

  /** Periodic registry refresh; call once from the host. */
  start(): void {
    void this.refresh();
    this.refreshTimer = setInterval(() => void this.refresh(), REFRESH_INTERVAL_MS);
    this.refreshTimer.unref?.();
  }

  /** Route one client frame; returns true when it was machine-scoped. */
  handleFrame(frame: ClientFrame): boolean {
    switch (frame.type) {
      case "list_machines":
        this.pushMachines();
        return true;
      case "machine_connect":
        void this.connect(frame.machine);
        return true;
      case "machine_disconnect":
        if (frame.machine !== LOCAL_ID) this.disconnect(frame.machine);
        return true;
      case "machine_add":
        void this.addMachine(frame);
        return true;
      default:
        break;
    }
    // Frames without a machine tag target the local endpoint.
    const machine = "machine" in frame && typeof frame.machine === "string" && frame.machine.length > 0
      ? frame.machine
      : LOCAL_ID;
    this.route(machine, frame);
    return true;
  }

  close(): void {
    this.closed = true;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    for (const id of [...this.sessions.keys()]) this.disconnect(id, true);
  }

  /* --------------------------- internals ------------------------------ */

  private ensureLocal(): void {
    const managed: ManagedSession = { session: createBridgeSession(this.wrap(LOCAL_ID), localEndpoint(), LOCAL_ID) };
    this.sessions.set(LOCAL_ID, managed);
    void managed.session.start();
  }

  private wrap(machine: string): (frame: ServerFrame) => void {
    return (frame) => {
      if (this.closed) return;
      this.observe(machine, frame);
      const managed = this.sessions.get(machine);
      if (frame.type === "ready" || frame.type === "snapshot") {
        // First successful data: deliver frames queued while connecting.
        const queued = this.pendingFrames.get(machine)?.splice(0) ?? [];
        for (const frame of queued) managed?.session.handleFrame(frame);
      }
      this.send(frame);
    };
  }

  /** Track per-machine status from the frames its session emits. */
  private observe(machine: string, frame: ServerFrame): void {
    const info = this.infos.get(machine);
    if (!info) return;
    switch (frame.type) {
      case "ready":
      case "snapshot": {
        const changed = info.status !== "online";
        info.status = "online";
        info.version = frame.snapshot.version;
        info.protocol = frame.snapshot.protocol;
        delete info.detail;
        if (changed) this.pushStatus(info);
        return;
      }
      case "rpc_result":
        if (!frame.ok && (frame.id === "boot" || frame.id === "bridge-health") && frame.error) {
          this.markFailure(machine, `${frame.error.code}: ${frame.error.message}`);
        }
        return;
      default:
        return;
    }
  }

  private markFailure(machine: string, text: string): void {
    const info = this.infos.get(machine);
    if (!info) return;
    // While a session is retrying on its own, keep showing the last known
    // state as reconnecting rather than flapping to error on every drop.
    const classified = classifySshFailure(text);
    const next: MachineStatus =
      classified.kind === "auth_required"
        ? "auth_required"
        : classified.kind === "incompatible"
          ? "incompatible"
          : info.status === "online"
            ? "reconnecting"
            : classified.kind === "unreachable"
              ? "unreachable"
              : "error";
    if (info.status === next && info.detail === classified.detail) return;
    info.status = next;
    info.detail = classified.detail;
    this.pushStatus(info);
  }

  private pushStatus(info: MachineInfo): void {
    this.send({ type: "machine_status", machine: { ...info } });
  }

  private route(machine: string, frame: ClientFrame): void {
    const managed = this.sessions.get(machine);
    if (managed) {
      managed.session.handleFrame(frame);
      return;
    }
    const info = this.infos.get(machine);
    if (!info || info.kind !== "ssh" || !info.enabled) {
      // Unknown or disabled machine: refuse with a synthetic rpc_result so
      // the caller is not left waiting.
      if (frame.type === "rpc") {
        this.send({
          type: "rpc_result",
          id: frame.id,
          ok: false,
          error: { code: "machine_unavailable", message: `machine ${machine} is not connected` },
          machine,
        });
      }
      return;
    }
    // Lazy connect: queue the frame and bring the session up; it is
    // delivered when the session first reports data (see wrap()).
    const queue = this.pendingFrames.get(machine) ?? [];
    queue.push(frame);
    this.pendingFrames.set(machine, queue);
    const pending = this.resolving.get(machine);
    void (pending ?? this.connect(machine));
  }

  /** Connect (or reconnect) a machine's bridge session. */
  async connect(machine: string): Promise<void> {
    if (this.closed) return;
    const existing = this.resolving.get(machine);
    if (existing) return existing;
    const promise = this.connectInner(machine).finally(() => this.resolving.delete(machine));
    this.resolving.set(machine, promise);
    return promise;
  }

  private async connectInner(machine: string): Promise<void> {
    const info = this.infos.get(machine);
    if (!info) return;
    if (machine === LOCAL_ID) {
      if (!this.sessions.has(LOCAL_ID)) this.ensureLocal();
      return;
    }
    if (info.kind !== "ssh" || !info.enabled) return;

    // Reconnect semantics: drop any stale session first.
    if (this.sessions.has(machine)) this.disconnect(machine);

    const saved = this.listSource().find((m) => m.id === machine);
    if (!saved) {
      info.status = "error";
      info.detail = "machine no longer exists in herdr's registry";
      this.pushStatus(info);
      return;
    }

    info.status = "connecting";
    delete info.detail;
    this.pushStatus(info);

    let endpoint: SshEndpoint;
    try {
      const metadata = loadMachineMetadata(machine);
      const remoteHerdr = await resolveRemoteHerdr(saved, metadata);
      endpoint = endpointFromMachine(saved, remoteHerdr);
    } catch (error) {
      if (this.closed) return;
      const text = error instanceof Error ? error.message : String(error);
      const classified = classifySshFailure(text);
      info.status =
        classified.kind === "auth_required"
          ? "auth_required"
          : classified.kind === "unreachable"
            ? "unreachable"
            : classified.kind === "incompatible"
              ? "incompatible"
              : "error";
      info.detail = classified.detail;
      this.pushStatus(info);
      return;
    }
    if (this.closed) return;

    const bridgeEndpoint: BridgeEndpoint = {
      api: sshApiConnector(endpoint),
      client: sshClientConnector(endpoint),
      label: `ssh:${endpoint.target}`,
    };
    const managed: ManagedSession = {
      session: createBridgeSession(this.wrap(machine), bridgeEndpoint, machine),
      endpoint: bridgeEndpoint,
    };
    this.sessions.set(machine, managed);
    void managed.session.start();
  }

  private disconnect(machine: string, keepStatus = false): void {
    this.pendingFrames.delete(machine);
    const managed = this.sessions.get(machine);
    if (managed) {
      managed.session.close();
      this.sessions.delete(machine);
    }
    if (!keepStatus) {
      const info = this.infos.get(machine);
      if (info && info.kind === "ssh") {
        info.status = "offline";
        info.detail = "disconnected";
        this.pushStatus(info);
      }
    }
  }

  /** Lightweight reachability probe for machines without a session. */
  private async probe(machine: string): Promise<void> {
    const info = this.infos.get(machine);
    if (!info || info.kind !== "ssh" || this.sessions.has(machine)) return;
    const saved = this.listSource().find((m) => m.id === machine);
    if (!saved) return;
    try {
      const metadata = loadMachineMetadata(machine);
      const remoteHerdr = await resolveRemoteHerdr(saved, metadata);
      const endpoint = endpointFromMachine(saved, remoteHerdr);
      const snapshot = await fetchSnapshot({
        api: sshApiConnector(endpoint),
        client: sshClientConnector(endpoint),
        label: `ssh:${endpoint.target}`,
      });
      if (this.closed) return;
      const changed = info.status !== "online";
      info.status = "online";
      info.version = snapshot.version;
      info.protocol = snapshot.protocol;
      delete info.detail;
      if (changed) this.pushStatus(info);
    } catch (error) {
      if (this.closed) return;
      const text = error instanceof Error ? error.message : String(error);
      const classified = classifySshFailure(text);
      const next: MachineStatus =
        classified.kind === "auth_required"
          ? "auth_required"
          : classified.kind === "unreachable"
            ? "unreachable"
            : classified.kind === "incompatible"
              ? "incompatible"
              : "error";
      if (info.status !== next || info.detail !== classified.detail) {
        info.status = next;
        info.detail = classified.detail;
        this.pushStatus(info);
      }
    }
  }

  /** `herdr machine add` shell-out; approval-requiring steps stay manual. */
  private async addMachine(frame: Extract<ClientFrame, { type: "machine_add" }>): Promise<void> {
    const args = ["machine", "add", "--label", frame.label];
    if (frame.session) args.push("--remote-session", frame.session);
    args.push(frame.target);
    const output = await new Promise<string>((resolve) => {
      const child = spawn("herdr", args, { stdio: ["ignore", "pipe", "pipe"] });
      let text = "";
      const collect = (c: Buffer) => {
        text = (text + c.toString("utf8")).slice(-16384);
      };
      child.stdout?.on("data", collect);
      child.stderr?.on("data", collect);
      const timer = setTimeout(() => {
        child.kill();
        resolve(`${text}\n[timed out after ${MACHINE_ADD_TIMEOUT_MS / 1000}s]`);
      }, MACHINE_ADD_TIMEOUT_MS);
      timer.unref?.();
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve(`failed to run herdr: ${err.message}`);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve(text + (code === 0 ? "" : `\n[exit ${code}]`));
      });
    });
    const ok = !output.includes("[exit") && !output.includes("[timed out");
    this.send(
      ok
        ? { type: "rpc_result", id: frame.id, ok: true, result: { output } }
        : {
            type: "rpc_result",
            id: frame.id,
            ok: false,
            error: { code: "machine_add_failed", message: output.slice(-500) },
          },
    );
    await this.refresh();
  }
}
