/*
 * Settings surface — port of T3 Code's AppRouteModal + SettingsSidebarNav
 * structure (issue #83, ADR-0008 §3): a large modal over the app with a
 * left section nav and grouped setting rows. All sections are live (issue
 * #85): settings persist through src/lib/settings.ts or the OS/desktop
 * bridge, Connections drives the same MachineManager registry the sidebar
 * uses, and Diagnostics/About report real bridge, herdr and engine state.
 */
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import {
  ArrowLeftIcon,
  EllipsisIcon,
  InfoIcon,
  PaletteIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  ServerIcon,
  Settings2Icon,
  TerminalIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { useNativeTitlebarHeight } from "~/lib/windowControlsOverlay";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { DialogBackdrop } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Switch } from "~/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Kbd } from "~/components/ui/kbd";
import { SidebarInput } from "~/components/ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/menu";
import {
  fetchHealth,
  getLoginItem,
  machineConnect,
  machineDisconnect,
  machineUpdate,
  setLoginItem,
  type LoginItemState,
} from "~/lib/api";
import type { HealthResponse, MachineInfo } from "../../shared/protocol";
import {
  getAppearanceMode,
  getGhosttyThemeName,
  isGhosttyActive,
  onAppearanceChange,
  setAppearanceMode,
  type AppearanceMode,
} from "~/lib/theme";
import {
  getGeneralSettings,
  getTerminalSettings,
  onGeneralSettingsChange,
  onTerminalSettingsChange,
  setGeneralSettings,
  setTerminalSettings,
  type TerminalSettings,
} from "~/lib/settings";
import {
  ghosttyEngineStatus,
  onGhosttyEngineStatus,
} from "~/lib/ghostty/session.ts";
import { MachineDialog, type MachineDialogState } from "~/components/MachineDialog";
import { machineListOf, useBridgeState } from "./bridge";
import { closeSettings, navigate, settingsHash, useRoute } from "./router";

const SECTIONS = [
  { id: "general", label: "General", icon: Settings2Icon },
  { id: "appearance", label: "Appearance", icon: PaletteIcon },
  { id: "connections", label: "Connections", icon: ServerIcon },
  { id: "terminal", label: "Terminal", icon: TerminalIcon },
  { id: "diagnostics", label: "Diagnostics", icon: WrenchIcon },
  { id: "about", label: "About", icon: InfoIcon },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

function SettingsRow({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div
      data-slot="settings-row"
      className="flex items-center justify-between gap-4 px-3 py-3 sm:px-4"
    >
      <div className="min-w-0 flex-1 space-y-1">
        <h3 className="text-sm font-medium text-foreground">{label}</h3>
        {description ? (
          <p className="text-xs leading-normal text-muted-foreground">{description}</p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

function SettingsSection({
  title,
  headerAction,
  children,
}: {
  title: string;
  headerAction?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex min-h-7 items-center justify-between gap-x-4 px-3 sm:px-4">
        <h2 className="flex min-h-7 items-center gap-2 text-base font-semibold text-foreground">
          {title}
        </h2>
        {headerAction ? (
          <div className="flex min-h-7 min-w-7 items-center justify-end">{headerAction}</div>
        ) : null}
      </div>
      <div
        data-slot="settings-group"
        className="relative overflow-visible rounded-xl border border-border/60 bg-card/40 shadow-xs/5 *:not-first:border-t *:not-first:border-border/50 [&>[data-slot=settings-row]]:rounded-none"
      >
        {children}
      </div>
    </section>
  );
}

/* Appearance mode lives in theme.ts; subscribing keeps the select in sync
 * when the mode changes from the OS or another surface. */
function useAppearanceMode(): AppearanceMode {
  return useSyncExternalStore(
    (listener) => onAppearanceChange(listener),
    getAppearanceMode,
    getAppearanceMode,
  );
}

function useTerminalSettings(): TerminalSettings {
  return useSyncExternalStore(onTerminalSettingsChange, getTerminalSettings, getTerminalSettings);
}

function useGhosttyEngine() {
  return useSyncExternalStore(onGhosttyEngineStatus, ghosttyEngineStatus, ghosttyEngineStatus);
}

function useHealth() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let alive = true;
    fetchHealth()
      .then((h) => {
        if (!alive) return;
        setHealth(h);
        setError(null);
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [nonce]);
  return { health, error, refresh: () => setNonce((n) => n + 1) };
}

const APPEARANCE_LABELS: Record<AppearanceMode, string> = {
  ghostty: "Ghostty sync",
  system: "System",
  dark: "Dark",
  light: "Light",
};

function statusBadgeVariant(status: MachineInfo["status"]) {
  return status === "online"
    ? "success"
    : status === "offline" || status === "unreachable" || status === "error"
      ? "error"
      : "warning";
}

/** Connect/disconnect/reconnect for one machine row; local cannot disconnect. */
function machineConnectAction(machine: MachineInfo): { label: string; run: () => void } | null {
  if (machine.kind === "local") return null;
  if (machine.status === "online" || machine.status === "connecting" || machine.status === "reconnecting") {
    return { label: "Disconnect", run: () => machineDisconnect(machine.id) };
  }
  if (!machine.enabled) return null;
  const reconnect = machine.status !== "offline";
  return { label: reconnect ? "Reconnect" : "Connect", run: () => machineConnect(machine.id) };
}

function MachineRow({
  machine,
  onDialog,
}: {
  machine: MachineInfo;
  onDialog: (state: MachineDialogState) => void;
}) {
  const action = machineConnectAction(machine);
  const ssh = machine.kind === "ssh";
  return (
    <SettingsRow
      label={machine.label}
      description={
        machine.detail ??
        (machine.kind === "local"
          ? "This machine"
          : [machine.target, machine.session].filter(Boolean).join(" · ") || "SSH endpoint")
      }
    >
      <Badge variant={statusBadgeVariant(machine.status)} size="sm">
        {machine.status}
        {machine.version ? ` · herdr ${machine.version}` : ""}
      </Badge>
      {action ? (
        <Button size="sm" variant="outline" onClick={action.run}>
          {action.label}
        </Button>
      ) : null}
      {ssh ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button size="icon-sm" variant="ghost" aria-label={`Actions for ${machine.label}`} />}
          >
            <EllipsisIcon />
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onClick={() => onDialog({ mode: "rename", machine })}>
              Rename…
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => void machineUpdate(machine.id, { enabled: !machine.enabled })}
            >
              {machine.enabled ? "Disable" : "Enable"}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => onDialog({ mode: "remove", machine })}>
              Remove…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </SettingsRow>
  );
}

function SectionPage({ section }: { section: SectionId }) {
  const appearance = useAppearanceMode();
  const terminal = useTerminalSettings();
  const general = useSyncExternalStore(
    onGeneralSettingsChange,
    getGeneralSettings,
    getGeneralSettings,
  );
  const [loginItem, setLoginItemState] = useState<LoginItemState | null>(null);
  const [machineDialog, setMachineDialog] = useState<MachineDialogState | null>(null);
  const bridge = useBridgeState();
  const machines = machineListOf(bridge);
  const { health, error: healthError, refresh: refreshHealth } = useHealth();
  const ghosttyEngine = useGhosttyEngine();
  useEffect(() => {
    let alive = true;
    void getLoginItem().then((state) => {
      if (alive && state) setLoginItemState(state);
    });
    return () => {
      alive = false;
    };
  }, []);

  switch (section) {
    case "general":
      return (
        <div className="flex flex-col gap-8">
          <SettingsSection title="Application">
            <SettingsRow
              label="Launch at login"
              description={
                loginItem === null
                  ? "Available in the desktop app."
                  : loginItem.supported
                    ? "Start herdr-t3 when you sign in."
                    : "Not supported on this platform."
              }
            >
              <Switch
                aria-label="Launch at login"
                checked={loginItem?.openAtLogin ?? false}
                disabled={loginItem === null || !loginItem.supported}
                onCheckedChange={(checked) => {
                  void setLoginItem(checked === true).then((state) => {
                    if (state) setLoginItemState(state);
                  });
                }}
              />
            </SettingsRow>
            <SettingsRow
              label="Confirm before closing workspace"
              description="Ask before closing a workspace that still has panes."
            >
              <Switch
                aria-label="Confirm before closing workspace"
                checked={general.confirmCloseWorkspace}
                onCheckedChange={(checked) =>
                  setGeneralSettings({ confirmCloseWorkspace: checked === true })
                }
              />
            </SettingsRow>
          </SettingsSection>
        </div>
      );
    case "appearance":
      return (
        <div className="flex flex-col gap-8">
          <SettingsSection title="Theme">
            <SettingsRow
              label="Appearance"
              description="Sync with Ghostty, follow the system, or pick a mode."
            >
              <Select
                value={appearance}
                onValueChange={(v) => setAppearanceMode(v as AppearanceMode)}
              >
                <SelectTrigger className="w-44">
                  <SelectValue>{APPEARANCE_LABELS[appearance]}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ghostty">Ghostty sync</SelectItem>
                  <SelectItem value="system">System</SelectItem>
                  <SelectItem value="dark">Dark</SelectItem>
                  <SelectItem value="light">Light</SelectItem>
                </SelectContent>
              </Select>
            </SettingsRow>
            <SettingsRow
              label="Ghostty theme sync"
              description={
                appearance === "ghostty"
                  ? isGhosttyActive()
                    ? `Terminal colors follow your Ghostty theme${getGhosttyThemeName() ? ` (${getGhosttyThemeName()})` : ""}.`
                    : "Ghostty sync selected, but no Ghostty palette is available — the default theme is used."
                  : "Terminal colors follow your Ghostty configuration."
              }
            >
              <Badge
                variant={appearance === "ghostty" && isGhosttyActive() ? "success" : "secondary"}
                size="sm"
              >
                {appearance === "ghostty"
                  ? isGhosttyActive()
                    ? "Active"
                    : "Unavailable"
                  : "Off"}
              </Badge>
            </SettingsRow>
          </SettingsSection>
        </div>
      );
    case "connections":
      return (
        <div className="flex flex-col gap-8">
          <SettingsSection
            title="Machines"
            headerAction={
              <Button size="sm" variant="outline" onClick={() => setMachineDialog({ mode: "add" })}>
                <PlusIcon className="size-3.5" />
                Add machine
              </Button>
            }
          >
            <p className="px-3 pb-2 pt-3 text-xs text-muted-foreground sm:px-4">
              SSH endpoints and the local session herdr-t3 can attach to.
            </p>
            {machines.map((m) => (
              <MachineRow key={m.id} machine={m} onDialog={setMachineDialog} />
            ))}
            {machines.length === 0 ? (
              <p className="px-3 pb-3 text-xs text-muted-foreground sm:px-4">
                No machines configured yet.
              </p>
            ) : null}
          </SettingsSection>
          <MachineDialog state={machineDialog} onClose={() => setMachineDialog(null)} />
        </div>
      );
    case "terminal":
      return (
        <div className="flex flex-col gap-8">
          <SettingsSection title="Terminal">
            <SettingsRow label="Font" description="Terminal font family; empty uses the app monospace stack.">
              <Input
                key={terminal.fontFamily}
                className="w-56"
                defaultValue={terminal.fontFamily}
                placeholder="SF Mono, Menlo, monospace"
                aria-label="Terminal font family"
                onBlur={(e) => {
                  const value = e.currentTarget.value.trim();
                  if (value !== terminal.fontFamily) setTerminalSettings({ fontFamily: value });
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                }}
              />
            </SettingsRow>
            <SettingsRow label="Font size" description="Base terminal size in pixels.">
              <Input
                className="w-24"
                type="number"
                min={8}
                max={32}
                step={0.5}
                value={terminal.fontSize}
                aria-label="Terminal font size"
                onChange={(e) => {
                  const value = Number(e.currentTarget.value);
                  if (Number.isFinite(value)) setTerminalSettings({ fontSize: value });
                }}
              />
            </SettingsRow>
            <SettingsRow label="Line height" description="Cell height as a multiple of the font size.">
              <Select
                value={terminal.lineHeight === null ? "auto" : String(terminal.lineHeight)}
                onValueChange={(v) =>
                  setTerminalSettings({ lineHeight: v === "auto" ? null : Number(v) })
                }
              >
                <SelectTrigger className="w-32">
                  <SelectValue>{terminal.lineHeight === null ? "Auto" : `${terminal.lineHeight}×`}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">Auto</SelectItem>
                  <SelectItem value="1.15">1.15×</SelectItem>
                  <SelectItem value="1.3">1.3×</SelectItem>
                  <SelectItem value="1.5">1.5×</SelectItem>
                </SelectContent>
              </Select>
            </SettingsRow>
            <SettingsRow
              label="Scrollback lines"
              description="Lines of history kept per pane; applies to open panes immediately."
            >
              <Input
                className="w-24"
                type="number"
                min={100}
                max={100000}
                step={100}
                value={terminal.scrollbackLines}
                aria-label="Terminal scrollback lines"
                onChange={(e) => {
                  const value = Number(e.currentTarget.value);
                  if (Number.isFinite(value)) setTerminalSettings({ scrollbackLines: value });
                }}
              />
            </SettingsRow>
          </SettingsSection>
        </div>
      );
    case "diagnostics":
      return (
        <div className="flex flex-col gap-8">
          <SettingsSection
            title="Diagnostics"
            headerAction={
              <Button size="sm" variant="ghost" onClick={refreshHealth}>
                <RefreshCwIcon className="size-3.5" />
                Refresh
              </Button>
            }
          >
            <SettingsRow label="Bridge" description="herdr RPC connection state.">
              <Badge
                variant={
                  bridge.connection === "open" ? "success" : bridge.connection === "closed" ? "error" : "warning"
                }
                size="sm"
              >
                {bridge.connection === "open"
                  ? "Connected"
                  : bridge.connection === "connecting"
                    ? "Connecting"
                    : "Disconnected"}
              </Badge>
            </SettingsRow>
            <SettingsRow
              label="Herdr"
              description={
                health?.herdr.reachable
                  ? `Reachable at ${health.herdr.socket}`
                  : health
                    ? `Unreachable${health.herdr.error ? ` — ${health.herdr.error}` : ""}`
                    : healthError ?? "Checking…"
              }
            >
              <Badge
                variant={health ? (health.herdr.reachable ? "success" : "error") : "secondary"}
                size="sm"
              >
                {health
                  ? health.herdr.reachable
                    ? `v${health.herdr.version ?? "?"} · protocol ${health.herdr.protocol ?? "?"}`
                    : "Unreachable"
                  : healthError
                    ? "Error"
                    : "Checking…"}
              </Badge>
            </SettingsRow>
            <SettingsRow
              label="Ghostty engine"
              description="libghostty-vt WASM terminal core."
            >
              <Badge
                variant={
                  ghosttyEngine === "ready" ? "success" : ghosttyEngine === "error" ? "error" : "secondary"
                }
                size="sm"
              >
                {ghosttyEngine === "idle"
                  ? "Not loaded"
                  : ghosttyEngine === "loading"
                    ? "Loading…"
                    : ghosttyEngine === "ready"
                      ? "Ready"
                      : "Error"}
              </Badge>
            </SettingsRow>
            <SettingsRow label="App version" description="Build identity for support.">
              <span className="font-mono text-xs text-muted-foreground">
                {health ? `${health.version} (${health.commit.slice(0, 8)})` : healthError ? "Unavailable" : "…"}
              </span>
            </SettingsRow>
          </SettingsSection>
        </div>
      );
    case "about":
      return (
        <div className="flex flex-col gap-8">
          <SettingsSection title="About">
            <SettingsRow label="herdr-t3" description="A personal GUI client for herdr.">
              <span className="font-mono text-xs text-muted-foreground">
                {health ? `${health.version} (${health.commit.slice(0, 8)})` : "…"}
              </span>
            </SettingsRow>
            <SettingsRow
              label="Design system"
              description="UI primitives and tokens from T3 Code (MIT)."
            >
              <Badge variant="secondary" size="sm">
                T3 Code
              </Badge>
            </SettingsRow>
            <SettingsRow
              label="Terminal engine"
              description="libghostty-vt compiled to WASM (MIT)."
            >
              <Badge variant="secondary" size="sm">
                Ghostty
              </Badge>
            </SettingsRow>
            <SettingsRow
              label="License"
              description="herdr-t3 is MIT licensed; third-party notices are in THIRD_PARTY_NOTICES.md."
            >
              <Badge variant="secondary" size="sm">
                MIT
              </Badge>
            </SettingsRow>
          </SettingsSection>
        </div>
      );
  }
}

export function SettingsModal() {
  const route = useRoute();
  const nativeTitlebarHeight = useNativeTitlebarHeight();
  const section = (route.name === "settings" ? route.section : null) ?? "general";
  const active = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0]!;
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const searching = query.trim().length > 0;
  const visibleSections = searching
    ? SECTIONS.filter((s) => s.label.toLowerCase().includes(query.trim().toLowerCase()))
    : SECTIONS;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "/") return;
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      event.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <DialogPrimitive.Root open>
      <DialogPrimitive.Portal>
        <DialogBackdrop />
        <DialogPrimitive.Viewport
          style={
            {
              "--app-modal-titlebar-height": `${nativeTitlebarHeight}px`,
              "--app-modal-top-inset": `max(env(safe-area-inset-top), ${nativeTitlebarHeight}px)`,
              "--app-modal-sm-top": `max(1.5rem, ${nativeTitlebarHeight}px)`,
            } as CSSProperties
          }
          className="fixed inset-0 z-50 flex items-center justify-center [-webkit-app-region:no-drag] sm:p-6 sm:pt-(--app-modal-sm-top) lg:p-10"
        >
          <DialogPrimitive.Popup
            ref={popupRef}
            initialFocus={popupRef}
            aria-label="Settings"
            data-app-modal=""
            className="relative flex size-full min-h-0 min-w-0 flex-col overflow-hidden bg-background max-sm:pt-(--app-modal-top-inset) max-sm:pb-safe text-foreground outline-none [-webkit-app-region:no-drag] max-sm:rounded-none sm:max-h-[60rem] sm:max-w-[80rem] sm:rounded-2xl sm:border sm:shadow-2xl/40"
          >
            <div
              aria-hidden
              className="absolute inset-x-0 top-0 hidden h-(--app-modal-titlebar-height) [-webkit-app-region:drag] max-sm:block"
            />
            <div className="relative flex min-h-0 flex-1">
              {/* Section nav — SettingsSidebarNav equivalent. */}
              <nav className="flex w-60 shrink-0 flex-col gap-1 overflow-y-auto border-r border-border bg-sidebar px-2 pt-2 pb-3 text-sidebar-foreground max-sm:hidden">
                <div className="flex h-8 items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-within:ring-1 focus-within:ring-inset focus-within:ring-ring/50">
                  <SearchIcon className="size-4 shrink-0 text-sidebar-muted-foreground/80" />
                  <SidebarInput
                    ref={searchRef}
                    nativeInput
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") setQuery("");
                    }}
                    placeholder="Search"
                    aria-label="Search settings"
                    className="min-w-0 flex-1"
                  />
                  {searching ? (
                    <Button
                      type="button"
                      size="icon-micro"
                      variant="ghost-muted"
                      className="shrink-0"
                      aria-label="Clear settings search"
                      onClick={() => {
                        setQuery("");
                        searchRef.current?.focus();
                      }}
                    >
                      <XIcon className="size-3" />
                    </Button>
                  ) : (
                    <Kbd>/</Kbd>
                  )}
                </div>
                {searching && visibleSections.length === 0 ? (
                  <p className="px-2 py-6 text-center text-xs text-sidebar-muted-foreground">
                    No settings found
                  </p>
                ) : null}
                <div className="mt-1 flex flex-col gap-1">
                  {visibleSections.map((s) => {
                    const Icon = s.icon;
                    const isActive = s.id === active.id;
                    return (
                      // oxlint-disable-next-line herdr-t3/no-raw-control -- ported T3 settings nav row; custom selected/hover chrome
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => navigate(settingsHash(s.id))}
                        className={cn(
                          "flex h-8 items-center gap-2 rounded-[var(--control-radius)] py-1.5 ps-2.5 pe-2 text-left text-sm outline-none transition-colors",
                          isActive
                            ? "bg-sidebar-row-selected font-medium text-sidebar-foreground"
                            : "text-sidebar-muted-foreground/80 hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
                        )}
                      >
                        <Icon className="size-4 shrink-0" />
                        <span className="min-w-0 flex-1 truncate">{s.label}</span>
                      </button>
                    );
                  })}
                </div>
              </nav>
              <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border ps-5 pe-2">
                  {/* Mobile: section picker instead of breadcrumb. */}
                  <div className="flex min-w-0 items-center gap-1 sm:hidden">
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label="Back to workspaces"
                      onClick={closeSettings}
                    >
                      <ArrowLeftIcon className="size-4" />
                    </Button>
                    <span className="text-sm font-medium text-foreground">{active.label}</span>
                  </div>
                  <nav
                    aria-label="Settings breadcrumb"
                    className="hidden min-w-0 sm:block"
                  >
                    <ol className="m-0 flex min-w-0 list-none items-center gap-2 p-0 text-sm sm:gap-3">
                      <li className="flex min-w-0 items-center font-medium text-muted-foreground">
                        <span className="block truncate">Settings</span>
                      </li>
                      <li aria-hidden className="flex shrink-0 items-center text-icon-muted">
                        /
                      </li>
                      <li
                        aria-current="page"
                        className="flex min-w-0 items-center font-medium text-foreground"
                      >
                        <span className="block truncate">{active.label}</span>
                      </li>
                    </ol>
                  </nav>
                  <div className="ms-auto flex shrink-0 items-center gap-1">
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label="Close"
                            onClick={closeSettings}
                          />
                        }
                      >
                        <XIcon />
                      </TooltipTrigger>
                      <TooltipPopup side="bottom">Close (Esc)</TooltipPopup>
                    </Tooltip>
                  </div>
                </header>
                <div className="min-h-0 flex-1 overflow-y-auto">
                  <div className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-5 pt-6 pb-12 sm:px-6">
                    <SectionPage section={active.id} />
                  </div>
                </div>
              </div>
            </div>
          </DialogPrimitive.Popup>
        </DialogPrimitive.Viewport>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
