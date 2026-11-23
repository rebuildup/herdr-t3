/*
 * Settings surface — port of T3 Code's AppRouteModal + SettingsSidebarNav
 * structure (issue #83, ADR-0008 §3): a large modal over the app with a
 * left section nav and grouped setting rows. Connections and Diagnostics
 * read live bridge state (issue #84); persistence and connection editing
 * remain M3 scope.
 */
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import {
  ArrowLeftIcon,
  InfoIcon,
  PaletteIcon,
  SearchIcon,
  ServerIcon,
  Settings2Icon,
  TerminalIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

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
  getAppearanceMode,
  setAppearanceMode,
  type AppearanceMode,
} from "~/lib/theme";
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

function SectionPage({ section }: { section: SectionId }) {
  const [appearance, setAppearance] = useState<AppearanceMode>(getAppearanceMode());
  const bridge = useBridgeState();
  const machines = machineListOf(bridge);

  switch (section) {
    case "general":
      return (
        <div className="flex flex-col gap-8">
          <SettingsSection title="Application">
            <SettingsRow label="Launch at login" description="Start herdr-t3 when you sign in.">
              <Switch defaultChecked aria-label="Launch at login" />
            </SettingsRow>
            <SettingsRow
              label="Confirm before closing workspace"
              description="Ask before closing a workspace with running panes."
            >
              <Switch aria-label="Confirm before closing workspace" />
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
                onValueChange={(v) => {
                  const mode = v as AppearanceMode;
                  setAppearance(mode);
                  setAppearanceMode(mode);
                }}
              >
                <SelectTrigger className="w-44">
                  <SelectValue>
                    {appearance === "ghostty"
                      ? "Ghostty sync"
                      : appearance === "system"
                        ? "System"
                        : appearance === "dark"
                          ? "Dark"
                          : "Light"}
                  </SelectValue>
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
              description="Terminal colors follow your Ghostty configuration."
            >
              <Badge variant="secondary" size="sm">
                {appearance === "ghostty" ? "Active" : "Off"}
              </Badge>
            </SettingsRow>
          </SettingsSection>
        </div>
      );
    case "connections":
      return (
        <div className="flex flex-col gap-8">
          <SettingsSection title="Machines">
            <p className="px-3 pb-2 pt-3 text-xs text-muted-foreground sm:px-4">
              SSH endpoints and local sessions herdr-t3 can attach to.
            </p>
            {machines.map((m) => (
              <SettingsRow
                key={m.id}
                label={m.label}
                description={
                  m.detail ??
                  (m.kind === "local"
                    ? "This machine"
                    : (m.target ?? "SSH endpoint"))
                }
              >
                <Badge
                  variant={
                    m.status === "online"
                      ? "success"
                      : m.status === "offline" || m.status === "unreachable" || m.status === "error"
                        ? "error"
                        : "warning"
                  }
                  size="sm"
                >
                  {m.status}
                </Badge>
              </SettingsRow>
            ))}
            {machines.length === 0 ? (
              <p className="px-3 pb-3 text-xs text-muted-foreground sm:px-4">
                No machines configured yet.
              </p>
            ) : null}
          </SettingsSection>
        </div>
      );
    case "terminal":
      return (
        <div className="flex flex-col gap-8">
          <SettingsSection title="Terminal">
            <SettingsRow label="Font" description="Terminal font family.">
              <Input className="w-56" defaultValue="SF Mono, Menlo, monospace" />
            </SettingsRow>
            <SettingsRow label="Font size" description="Base terminal size in pixels.">
              <Input className="w-24" defaultValue="13" />
            </SettingsRow>
            <SettingsRow label="Scrollback lines" description="Lines kept per pane.">
              <Input className="w-24" defaultValue="10000" />
            </SettingsRow>
          </SettingsSection>
        </div>
      );
    case "diagnostics":
      return (
        <div className="flex flex-col gap-8">
          <SettingsSection title="Diagnostics">
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
              label="Ghostty engine"
              description="libghostty-vt WASM terminal core."
            >
              <Badge variant="success" size="sm">
                Loaded
              </Badge>
            </SettingsRow>
            <SettingsRow label="Version" description="Build identity for support.">
              <span className="font-mono text-xs text-muted-foreground">0.3.0-dev</span>
            </SettingsRow>
          </SettingsSection>
        </div>
      );
    case "about":
      return (
        <div className="flex flex-col gap-8">
          <SettingsSection title="About">
            <SettingsRow label="herdr-t3" description="A personal GUI client for herdr.">
              <span className="font-mono text-xs text-muted-foreground">0.3.0-dev</span>
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
