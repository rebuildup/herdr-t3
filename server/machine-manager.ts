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
import type { ClientFrame, MachineInfo, MachineStatus, ServerFrame, SessionSnapshot } from "../shared/protocol.ts";
import { createBridgeSession, fetchSnapshot, localEndpoint, type BridgeEndpoint, type BridgeSession } from "./bridge-core.ts";
import { HerdrError } from "./herdr.ts";
import { loadMachineMetadata, loadSavedMachines, type SavedMachine } from "./machines.ts";
import { localPluginHost, PluginService, type PluginHost } from "./plugins.ts";
import {
  classifySshFailure,
  endpointFromMachine,
  resolveRemoteHerdr,
  sshApiConnector,
  sshClientConnector,
  sshPluginHost,
  type SshEndpoint,
} from "./ssh.ts";

const LOCAL_ID = "local";
const REFRESH_INTERVAL_MS = 60_000;
const MACHINE_ADD_TIMEOUT_MS = 120_000;
const MACHINE_OP_TIMEOUT_MS = 30_000;

interface ManagedSession {
  session: BridgeSession;
  endpoint?: BridgeEndpoint;
}

export interface MachineManagerOptions {
  send: (frame: ServerFrame) => void;
  /** Override for tests: machine list source. */
  listMachines?: () => SavedMachine[];
  /** Override for tests: the `herdr machine …` shell-out. */
  runHerdr?: (args: string[], timeoutMs: number) => Promise<string>;
  /** Override for tests: the snapshot fetch used by probe() (issue #212). */
  probeFetch?: (machine: string) => Promise<SessionSnapshot>;
}

export class MachineManager {
  private readonly send: (frame: ServerFrame) => void;
  private readonly listSource: () => SavedMachine[];
  private readonly herdrRunner: (args: string[], timeoutMs: number) => Promise<string>;
  private readonly probeFetcher: ((machine: string) => Promise<SessionSnapshot>) | null;
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly infos = new Map<string, MachineInfo>();
  private readonly resolving = new Map<string, Promise<void>>();
  /** Connect generation per machine: bumped on every connect/disconnect so
   * stale async resolutions cannot install a session for an old attempt. */
  private readonly generations = new Map<string, number>();
  /** Frames received for a machine whose session is still connecting.
   * Only idempotent attach-lifecycle frames may queue; anything that can
   * carry user input or mutate state is refused instead of being flushed
   * later (nothing typed or commanded during an outage may auto-send). */
  private readonly pendingFrames = new Map<string, ClientFrame[]>();
  /** Last snapshot JSON pushed per machine by probe(), for dedupe (issue #212). */
  private readonly lastProbeSnapshots = new Map<string, string>();
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  /** Plugin contract boundary (ADR-0011): host argv exec per machine. */
  private readonly plugins: PluginService;
  /** Resolved plugin hosts per machine (local + ssh), cached for reuse. */
  private readonly pluginHosts = new Map<string, PluginHost>();

  constructor(options: MachineManagerOptions) {
    this.send = options.send;
    this.listSource = options.listMachines ?? (() => loadSavedMachines());
    this.herdrRunner = options.runHerdr ?? ((args, timeoutMs) => this.spawnHerdr(args, timeoutMs));
    this.plugins = new PluginService((machine) => this.pluginHost(machine));
    this.probeFetcher = options.probeFetch ?? null;
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
    // A missing local session means the last boot attempt failed; rebuild it
    // so the app recovers once herdr comes back without a restart (#99).
    if (!this.sessions.has(LOCAL_ID)) this.ensureLocal();
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
      case "machine_remove":
        void this.removeMachine(frame);
        return true;
      case "machine_update":
        void this.updateMachine(frame);
        return true;
      case "plugin_list":
      case "plugin_call":
        void this.handlePluginFrame(frame);
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
          // A boot failure means the session never connected; drop it so a
          // later connect()/refresh() can rebuild it instead of leaving the
          // machine permanently disconnected until app restart (issue #99).
          if (frame.id === "boot") this.disconnect(machine, true);
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
    // Only subscribe/unsubscribe are safe to defer: they re-attach a
    // viewer and carry no user input or mutation. rpc frames get an
    // explicit machine_connecting error; terminal input/resize are
    // dropped — whatever the user typed while the machine was down must
    // never land in a pane after reconnect (draft semantics, issue #5).
    if (frame.type === "subscribe_terminal" || frame.type === "unsubscribe_terminal") {
      const queue = this.pendingFrames.get(machine) ?? [];
      queue.push(frame);
      this.pendingFrames.set(machine, queue);
    } else if (frame.type === "rpc") {
      this.send({
        type: "rpc_result",
        id: frame.id,
        ok: false,
        error: { code: "machine_connecting", message: `machine ${machine} is still connecting` },
        machine,
      });
    }
    const pending = this.resolving.get(machine);
    void (pending ?? this.connect(machine));
  }

  /** Connect (or reconnect) a machine's bridge session. */
  async connect(machine: string): Promise<void> {
    if (this.closed) return;
    const existing = this.resolving.get(machine);
    if (existing) return existing;
    const generation = (this.generations.get(machine) ?? 0) + 1;
    this.generations.set(machine, generation);
    const promise = this.connectInner(machine, generation).finally(() => {
      // Only remove our own entry: a disconnect/reconnect may already have
      // installed a newer attempt under the same machine id.
      if (this.resolving.get(machine) === promise) this.resolving.delete(machine);
    });
    this.resolving.set(machine, promise);
    return promise;
  }

  private generationCurrent(machine: string, generation: number): boolean {
    return !this.closed && this.generations.get(machine) === generation;
  }

  private async connectInner(machine: string, generation: number): Promise<void> {
    const info = this.infos.get(machine);
    if (!info || !this.generationCurrent(machine, generation)) return;
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
      endpoint = endpointFromMachine(saved, remoteHerdr, metadata?.os);
    } catch (error) {
      if (!this.generationCurrent(machine, generation)) return;
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
    if (!this.generationCurrent(machine, generation)) return;

    this.pluginHosts.set(machine, sshPluginHost(endpoint, saved.session));
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
    // Invalidate any in-flight connect for this machine: its async
    // resolution must not install a session after the user disconnected.
    this.generations.set(machine, (this.generations.get(machine) ?? 0) + 1);
    // Drop the in-flight attempt's slot so a later connect() starts fresh;
    // its connectInner aborts itself via the generation check.
    this.resolving.delete(machine);
    this.pendingFrames.delete(machine);
    this.pluginHosts.delete(machine);
    this.plugins.invalidate(machine);
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

  /** SSH reachability fetch behind probe(); tests inject probeFetch instead. */
  private async fetchProbeSnapshot(machine: string, saved: SavedMachine): Promise<SessionSnapshot> {
    const metadata = loadMachineMetadata(machine);
    const remoteHerdr = await resolveRemoteHerdr(saved, metadata);
    const endpoint = endpointFromMachine(saved, remoteHerdr, metadata?.os);
    return fetchSnapshot({
      api: sshApiConnector(endpoint),
      client: sshClientConnector(endpoint),
      label: `ssh:${endpoint.target}`,
    });
  }

  /** Lightweight reachability probe for machines without a session. */
  private async probe(machine: string): Promise<void> {
    const info = this.infos.get(machine);
    if (!info || info.kind !== "ssh" || this.sessions.has(machine)) return;
    const saved = this.listSource().find((m) => m.id === machine);
    if (!saved) return;
    try {
      const snapshot = this.probeFetcher
        ? await this.probeFetcher(machine)
        : await this.fetchProbeSnapshot(machine, saved);
      // The machine may have been connected, disabled or removed while the
      // probe was in flight; only publish the result if nothing changed.
      if (this.closed || this.infos.get(machine) !== info || this.sessions.has(machine) || !info.enabled) return;
      // Hand the probed snapshot to clients so workspace/agent lists show
      // remote state without holding a session (issue #212). Deduped: an
      // unchanged session would otherwise re-render every client each
      // refresh interval.
      const json = JSON.stringify(snapshot);
      if (this.lastProbeSnapshots.get(machine) !== json) {
        this.lastProbeSnapshots.set(machine, json);
        this.send({ type: "snapshot", snapshot, machine, probe: true });
      }
      const changed = info.status !== "online";
      info.status = "online";
      info.version = snapshot.version;
      info.protocol = snapshot.protocol;
      delete info.detail;
      if (changed) this.pushStatus(info);
    } catch (error) {
      if (this.closed || this.infos.get(machine) !== info || this.sessions.has(machine) || !info.enabled) return;
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

  /** `herdr machine <args>` shell-out; approval-requiring steps stay manual. */
  private spawnHerdr(args: string[], timeoutMs: number): Promise<string> {
    return new Promise<string>((resolve) => {
      const child = spawn("herdr", args, { stdio: ["ignore", "pipe", "pipe"] });
      let text = "";
      const collect = (c: Buffer) => {
        text = (text + c.toString("utf8")).slice(-16384);
      };
      child.stdout?.on("data", collect);
      child.stderr?.on("data", collect);
      const timer = setTimeout(() => {
        child.kill();
        resolve(`${text}\n[timed out after ${timeoutMs / 1000}s]`);
      }, timeoutMs);
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
  }

  private machineResult(id: string, output: string, code: string, forcedOk?: boolean): void {
    const ok = forcedOk ?? (!output.includes("[exit") && !output.includes("[timed out"));
    this.send(
      ok
        ? { type: "rpc_result", id, ok: true, result: { output } }
        : { type: "rpc_result", id, ok: false, error: { code, message: output.slice(-500) } },
    );
  }

  /** `herdr machine add` shell-out; approval-requiring steps stay manual. */
  private async addMachine(frame: Extract<ClientFrame, { type: "machine_add" }>): Promise<void> {
    const args = ["machine", "add", "--label", frame.label];
    if (frame.session) args.push("--remote-session", frame.session);
    args.push(frame.target);
    const output = await this.herdrRunner(args, MACHINE_ADD_TIMEOUT_MS);
    this.machineResult(frame.id, output, "machine_add_failed");
    await this.refresh();
  }

  /** `herdr machine remove` shell-out; the registry refresh drops the session. */
  private async removeMachine(frame: Extract<ClientFrame, { type: "machine_remove" }>): Promise<void> {
    if (frame.machine === LOCAL_ID) {
      this.machineResult(frame.id, "the local machine cannot be removed", "machine_remove_failed", false);
      return;
    }
    const output = await this.herdrRunner(["machine", "remove", frame.machine], MACHINE_OP_TIMEOUT_MS);
    this.machineResult(frame.id, output, "machine_remove_failed");
    await this.refresh();
  }

  /** `herdr machine rename|enable|disable` shell-outs, run in order. */
  private async updateMachine(frame: Extract<ClientFrame, { type: "machine_update" }>): Promise<void> {
    const commands: string[][] = [];
    if (frame.label !== undefined) commands.push(["machine", "rename", frame.machine, "--label", frame.label]);
    if (frame.enabled !== undefined) {
      commands.push(["machine", frame.enabled ? "enable" : "disable", frame.machine]);
    }
    let output = "";
    for (const args of commands) {
      output += await this.herdrRunner(args, MACHINE_OP_TIMEOUT_MS);
      if (output.includes("[exit") || output.includes("[timed out")) break;
    }
    this.machineResult(frame.id, output.trim(), "machine_update_failed");
    await this.refresh();
  }

  /* ------------------------- plugin boundary ------------------------- */

  /**
   * Plugin contract frames (ADR-0011): discovery and contract calls run
   * as argv on the machine's own host — independent of whether its bridge
   * session is up, but still requiring a resolvable host.
   */
  private async handlePluginFrame(
    frame: Extract<ClientFrame, { type: "plugin_list" | "plugin_call" }>,
  ): Promise<void> {
    const machine =
      "machine" in frame && typeof frame.machine === "string" && frame.machine.length > 0
        ? frame.machine
        : LOCAL_ID;
    try {
      const result =
        frame.type === "plugin_list"
          ? await this.plugins.listPlugins(machine)
          : await this.plugins.call(machine, {
              plugin: frame.plugin,
              command: frame.command,
              args: frame.args,
              timeoutMs: frame.timeout_ms,
            });
      this.send({ type: "rpc_result", id: frame.id, ok: true, result, machine });
    } catch (error: unknown) {
      const err = error instanceof HerdrError ? error : new HerdrError("plugin_error", String(error));
      this.send({
        type: "rpc_result",
        id: frame.id,
        ok: false,
        error: { code: err.code, message: err.message },
        machine,
      });
    }
  }

  /** PluginHost for one machine: local spawn, or ssh argv on the endpoint. */
  private async pluginHost(machine: string): Promise<PluginHost | null> {
    if (machine === LOCAL_ID) return localPluginHost();
    const cached = this.pluginHosts.get(machine);
    if (cached) return cached;
    const info = this.infos.get(machine);
    if (!info || info.kind !== "ssh" || !info.enabled) return null;
    const saved = this.listSource().find((m) => m.id === machine);
    if (!saved) return null;
    try {
      const metadata = loadMachineMetadata(machine);
      const remoteHerdr = await resolveRemoteHerdr(saved, metadata);
      const endpoint = endpointFromMachine(saved, remoteHerdr, metadata?.os);
      const host = sshPluginHost(endpoint, saved.session);
      this.pluginHosts.set(machine, host);
      return host;
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      throw new HerdrError("plugin_host_unreachable", `cannot reach ${machine} for plugin execution: ${text}`);
    }
  }
}
