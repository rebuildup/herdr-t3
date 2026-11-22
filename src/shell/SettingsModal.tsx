/*
 * Settings surface — port of T3 Code's AppRouteModal + SettingsSidebarNav
 * structure (issue #83, ADR-0008 §3): a large modal over the app with a
 * left section nav and grouped setting rows. Fixture content only; M3
 * wires real persistence.
 */
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import {
  ActivityIcon,
  ArrowLeftIcon,
  InfoIcon,
  PaletteIcon,
  ServerIcon,
  Settings2Icon,
  TerminalIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import { useState, type CSSProperties, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { useNativeTitlebarHeight } from "~/lib/windowControlsOverlay";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { DialogBackdrop } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import {
  getAppearanceMode,
  setAppearanceMode,
  type AppearanceMode,
} from "~/lib/theme";
import { FIXTURE_MACHINES } from "./fixtures";
import { closeSettings, navigate, settingsHash, useRoute } from "./router";

const SECTIONS = [
  { id: "general", label: "General", icon: Settings2Icon },
  { id: "appearance", label: "Appearance", icon: PaletteIcon },
  { id: "connections", label: "Connections", icon: ServerIcon },
  { id: "terminal", label: "Terminal", icon: TerminalIcon },
  { id: "diagnostics", label: "Diagnostics", icon: ActivityIcon },
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
    <div className="flex items-center justify-between gap-4 py-3">
      <div className="min-w-0">
        <div className="text-sm font-medium text-foreground">{label}</div>
        {description ? (
          <div className="mt-0.5 text-xs text-muted-foreground">{description}</div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

function FixtureToggle({ on, label }: { on: boolean; label: string }) {
  return (
    // oxlint-disable-next-line herdr-t3/no-raw-control -- fixture toggle; M3 wires real settings controls
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      className={cn(
        "relative h-5 w-9 rounded-full transition-colors",
        on ? "bg-primary" : "bg-input",
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 size-4 rounded-full bg-white transition-all",
          on ? "right-0.5" : "left-0.5",
        )}
      />
    </button>
  );
}

function SettingsSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <h2 className="mb-2 text-sm font-semibold text-foreground">{title}</h2>
      <div className="divide-y divide-border/60">{children}</div>
    </section>
  );
}

function SectionPage({ section }: { section: SectionId }) {
  const [appearance, setAppearance] = useState<AppearanceMode>(getAppearanceMode());

  switch (section) {
    case "general":
      return (
        <div className="flex flex-col gap-8">
          <SettingsSection title="Application">
            <SettingsRow label="Launch at login" description="Start herdr-t3 when you sign in.">
              <FixtureToggle on label="Launch at login" />
            </SettingsRow>
            <SettingsRow
              label="Confirm before closing workspace"
              description="Ask before closing a workspace with running panes."
            >
              <FixtureToggle on={false} label="Confirm before closing workspace" />
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
                  <SelectValue />
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
            <p className="pb-3 text-xs text-muted-foreground">
              SSH endpoints and local sessions herdr-t3 can attach to.
            </p>
            {FIXTURE_MACHINES.map((m) => (
              <SettingsRow
                key={m.id}
                label={m.label}
                description={
                  m.detail ?? (m.kind === "local" ? "This machine" : "SSH endpoint")
                }
              >
                <Badge
                  variant={
                    m.status === "online" ? "success" : m.status === "offline" ? "error" : "warning"
                  }
                  size="sm"
                >
                  {m.status}
                </Badge>
              </SettingsRow>
            ))}
            <div className="pt-3">
              <Button variant="outline" size="sm">
                Add machine…
              </Button>
            </div>
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
              <Badge variant="success" size="sm">
                Connected
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
              <span className="font-mono text-xs text-muted-foreground">0.3.0-dev · fixture</span>
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
  const ActiveIcon = active.icon;

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
              <nav className="flex w-52 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border/60 p-3 max-sm:hidden">
                <div className="px-2 pb-2 pt-1 text-2xs font-medium uppercase tracking-wide text-sidebar-muted-foreground">
                  Settings
                </div>
                {SECTIONS.map((s) => {
                  const Icon = s.icon;
                  const isActive = s.id === active.id;
                  return (
                    // oxlint-disable-next-line herdr-t3/no-raw-control -- ported T3 settings nav row; custom selected/hover chrome
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => navigate(settingsHash(s.id))}
                      className={cn(
                        "flex h-8 items-center gap-2.5 rounded-[var(--control-radius)] px-2.5 text-left text-sm outline-none transition-colors",
                        isActive
                          ? "bg-sidebar-row-selected font-medium text-sidebar-foreground"
                          : "text-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
                      )}
                    >
                      <Icon className="size-4 shrink-0" />
                      <span className="min-w-0 flex-1 truncate">{s.label}</span>
                    </button>
                  );
                })}
              </nav>
              <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border/60 ps-5 pe-2">
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
                  <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-5 pt-6 pb-12 sm:px-6">
                    <div className="flex items-center gap-2">
                      <ActiveIcon className="size-5 text-muted-foreground" />
                      <h1 className="text-lg font-semibold text-foreground">{active.label}</h1>
                    </div>
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
