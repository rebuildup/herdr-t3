/*
 * Appearance-mode tiles for Settings → Appearance (issue #85). Ported from
 * t3code apps/web/src/components/settings/ThemeSettings.tsx renderModeTiles +
 * ThemeWireframe.tsx: three preview tiles (System/Light/Dark) with a
 * wireframe mini-preview and an accent ring on the active mode. Colors are
 * herdr-t3's own light/dark token approximations — the wireframe is a
 * stylized preview, not a live theme render.
 */
import { cn } from "~/lib/utils";

interface PreviewColors {
  canvas: string;
  sidebar: string;
  surface: string;
  accentSurface: string;
  messageSurface: string;
  messageAction: string;
}

const PREVIEW_COLORS: Record<"light" | "dark", PreviewColors> = {
  light: {
    canvas: "#fafafa",
    sidebar: "#f4f4f5",
    surface: "#ffffff",
    accentSurface: "#f4f4f5",
    messageSurface: "#f4f4f5",
    messageAction: "#3b5bdb",
  },
  dark: {
    canvas: "#000000",
    sidebar: "#0d0d0d",
    surface: "#171717",
    accentSurface: "rgb(255 255 255 / 4%)",
    messageSurface: "#1c1c1c",
    messageAction: "#5b8cff",
  },
};

function WireframePane({ colors }: { colors: PreviewColors }) {
  const line = "rgb(127 127 127 / 0.25)";
  return (
    <span className="absolute inset-0">
      <span className="absolute inset-0" style={{ backgroundColor: colors.canvas }} />
      <span
        className="absolute inset-y-0 left-0 w-[22%]"
        style={{ backgroundColor: colors.sidebar, boxShadow: `inset -1px 0 0 ${line}` }}
      />
      <span
        className="absolute left-[3%] top-[8%] h-[8%] w-[16%] rounded-md"
        style={{ backgroundColor: colors.surface, boxShadow: `inset 0 0 0 1px ${line}` }}
      />
      <span
        className="absolute left-[3%] top-[22%] h-[7%] w-[16%] rounded-md"
        style={{ backgroundColor: colors.accentSurface }}
      />
      <span
        className="absolute left-[3%] top-[32%] h-[7%] w-[16%] rounded-md"
        style={{ backgroundColor: colors.messageSurface, opacity: 0.7 }}
      />
      <span
        className="absolute left-[3%] top-[42%] h-[7%] w-[16%] rounded-md"
        style={{ backgroundColor: colors.messageSurface, opacity: 0.5 }}
      />
      <span
        className="absolute right-[28%] top-[11%] h-[9%] w-[24%] rounded-lg"
        style={{ backgroundColor: colors.messageSurface }}
      />
      <span
        className="absolute left-[27%] top-[28%] h-[5%] w-[34%] rounded-sm"
        style={{ backgroundColor: line }}
      />
      <span
        className="absolute left-[27%] top-[38%] h-[5%] w-[26%] rounded-sm"
        style={{ backgroundColor: line }}
      />
      <span
        className="absolute bottom-[8%] left-[26%] right-[6%] flex h-[15%] items-center justify-between rounded-md px-1"
        style={{ backgroundColor: colors.surface, boxShadow: `inset 0 0 0 1px ${line}` }}
      >
        <span
          className="block h-[26%] w-[34%] rounded-full"
          style={{ backgroundColor: line, opacity: 0.7 }}
        />
        <span
          className="block aspect-square h-[58%] rounded-full"
          style={{ backgroundColor: colors.messageAction }}
        />
      </span>
      <span
        className="absolute right-[5%] top-[8%] h-[46%] w-[20%] rounded-lg"
        style={{
          backgroundColor: colors.surface,
          boxShadow: `inset 0 0 0 1px ${line}, 0 2px 5px rgb(0 0 0 / 0.14)`,
        }}
      >
        {[0, 1, 2].map((row) => (
          <span
            className="absolute left-[11%] right-[11%] flex items-center gap-1"
            key={row}
            style={{ top: `${10 + row * 30}%`, height: "20%" }}
          >
            <span
              className="block aspect-square h-[26%] rounded-full"
              style={{
                backgroundColor:
                  row === 0 ? "#34d399" : row === 1 ? colors.messageAction : "#fbbf24",
                opacity: 0.55,
              }}
            />
            <span className="block h-[30%] w-[52%] rounded-sm" style={{ backgroundColor: line }} />
          </span>
        ))}
      </span>
    </span>
  );
}

function ModeWireframe({ mode }: { mode: "system" | "light" | "dark" }) {
  const panes: { colors: PreviewColors; clip?: "left" | "right" }[] =
    mode === "system"
      ? [
          { colors: PREVIEW_COLORS.light, clip: "left" },
          { colors: PREVIEW_COLORS.dark, clip: "right" },
        ]
      : [{ colors: mode === "dark" ? PREVIEW_COLORS.dark : PREVIEW_COLORS.light }];
  return (
    <span
      aria-hidden
      className="relative block h-[8.75rem] w-full overflow-hidden rounded-lg border border-border/60"
    >
      {panes.map((pane) => (
        <span
          className="absolute inset-0"
          key={pane.clip ?? "pane"}
          style={
            pane.clip === undefined
              ? undefined
              : {
                  clipPath:
                    pane.clip === "left"
                      ? "polygon(0 0, calc(50% - 1px) 0, calc(50% - 1px) 100%, 0 100%)"
                      : "polygon(calc(50% + 1px) 0, 100% 0, 100% 100%, calc(50% + 1px) 100%)",
                }
          }
        >
          <WireframePane colors={pane.colors} />
        </span>
      ))}
    </span>
  );
}

const MODE_LABELS = { system: "System", light: "Light", dark: "Dark" } as const;
const MODE_ARIA = {
  system: "Follow the system appearance",
  light: "Use light mode",
  dark: "Use dark mode",
} as const;

export function ThemeModeTiles({
  mode,
  onChange,
}: {
  /** "ghostty" (herdr-t3 sync mode) matches no tile — the sync switch below owns it. */
  mode: "system" | "light" | "dark" | "ghostty";
  onChange: (mode: "system" | "light" | "dark") => void;
}) {
  return (
    <div aria-label="Appearance mode" className="grid w-full grid-cols-3 gap-3" role="group">
      {(["system", "light", "dark"] as const).map((m) => {
        const isActive = mode === m;
        return (
          // oxlint-disable-next-line herdr-t3/no-raw-control -- ported T3 theme tile; custom preview chrome
          <button
            aria-label={MODE_ARIA[m]}
            aria-pressed={isActive}
            className={cn(
              "flex cursor-pointer flex-col items-stretch gap-1.5 rounded-xl border p-2 outline-none transition-colors focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-7 focus-visible:outline-foreground/60",
              isActive
                ? "border-transparent bg-accent/30 ring-2 ring-inset ring-ring"
                : "border-border/70 bg-card/60 hover:bg-accent/10",
            )}
            key={m}
            onClick={() => onChange(m)}
            type="button"
          >
            <ModeWireframe mode={m} />
            <span
              className={cn(
                "flex items-center justify-center text-xs font-medium",
                isActive ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {MODE_LABELS[m]}
            </span>
          </button>
        );
      })}
    </div>
  );
}
