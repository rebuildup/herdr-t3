/*
 * Agent harness brand icon for sidebar rows and hover cards (issues #198,
 * #311, #335). Resolution order comes from shared/agent-icons.json via
 * agentKind.ts: T3 Code provider artwork (agentIconData.ts), then bundled
 * official SVGs (agent-icons/ — ACP Registry plus per-vendor assets), then
 * a generic agent glyph. The initials tile fallback is gone (#311:
 * icon-only display); the kind label itself is suppressed as row meta by
 * isAgentKindName regardless of which icon family renders (#335).
 */
import { Bot } from "lucide-react";
import { useId, useState } from "react";

import { cn } from "~/lib/utils";
import { AGENT_ICON_DATA, type AgentIconSpec } from "./agentIconData";
import {
  agentIconSource,
  bundledAgentIconUrl,
  canonicalAgentKind,
} from "./agentKind";

export function agentIconSpec(agent: string | null | undefined): AgentIconSpec | null {
  const key = agent?.trim().toLowerCase();
  // Own-property lookup only: agent labels are arbitrary strings and a
  // plain index would resolve inherited members like `constructor`.
  if (!key || !Object.hasOwn(AGENT_ICON_DATA, key)) return null;
  return AGENT_ICON_DATA[key] ?? null;
}

function GenericAgentIcon({ className }: { className: string | undefined }) {
  return <Bot className={cn("shrink-0 text-muted-foreground", className)} aria-hidden />;
}

function T3BrandIcon({
  spec,
  className,
}: {
  spec: AgentIconSpec;
  className: string | undefined;
}) {
  const gradientId = useId();
  return (
    <svg
      viewBox={spec.viewBox}
      preserveAspectRatio="xMidYMid meet"
      fill="none"
      className={`shrink-0 fill-(--icon-light) dark:fill-(--icon-dark) ${className ?? ""}`}
      style={
        {
          "--icon-light": spec.fill.light,
          "--icon-dark": spec.fill.dark,
        } as React.CSSProperties
      }
      aria-hidden
    >
      {spec.paths.some((path) => path.gradient) ? (
        <defs>
          {spec.paths.map((path, index) =>
            path.gradient ? (
              <linearGradient
                key={index}
                id={`${gradientId}-${index}`}
                x1={path.gradient.x1}
                y1={path.gradient.y1}
                x2={path.gradient.x2}
                y2={path.gradient.y2}
                gradientUnits="userSpaceOnUse"
              >
                {path.gradient.stops.map((stop) => (
                  <stop key={stop.offset} offset={stop.offset} stopColor={stop.color} />
                ))}
              </linearGradient>
            ) : null,
          )}
        </defs>
      ) : null}
      {spec.paths.map((path, index) => (
        <path
          key={index}
          d={path.d}
          fillRule={path.fillRule}
          fill={path.gradient ? `url(#${gradientId}-${index})` : undefined}
          className={
            path.fill
              ? "fill-(--path-light) dark:fill-(--path-dark)"
              : undefined
          }
          style={
            path.fill
              ? ({
                  "--path-light": path.fill.light,
                  "--path-dark": path.fill.dark,
                } as React.CSSProperties)
              : undefined
          }
        />
      ))}
    </svg>
  );
}

// Bundled glyphs are recolored to the surrounding text color through an
// SVG filter: rendered through an <img> they cannot inherit currentColor
// (ACP Registry assets are monochrome `currentColor`; the oh-my-pi mark
// uses fixed fills — the filter flattens either to a currentColor
// silhouette). This mirrors T3's AcpRegistryAgentIcon (AcpRegistryIcon.tsx
// @ 9cc4018c), including its container + `size-full object-contain`
// sizing so non-square viewBoxes letterbox instead of distorting. The
// failed state is keyed by URL so an agent change never inherits a
// previous image's load failure, and the filter id is per-instance
// because filter ids are document-global.
function SvgAssetIcon({
  url,
  className,
}: {
  url: string;
  className: string | undefined;
}) {
  const filterId = useId();
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (failedUrl === url) return <GenericAgentIcon className={className} />;
  return (
    <span className={cn("inline-flex shrink-0 items-center justify-center", className)}>
      <svg aria-hidden className="pointer-events-none absolute size-0" focusable="false">
        <defs>
          <filter id={filterId} colorInterpolationFilters="sRGB">
            <feFlood floodColor="currentColor" />
            <feComposite in2="SourceAlpha" operator="in" />
          </filter>
        </defs>
      </svg>
      <img
        src={url}
        alt=""
        aria-hidden
        draggable={false}
        decoding="async"
        className="size-full object-contain"
        style={{ filter: `url(#${filterId})` }}
        onError={() => setFailedUrl(url)}
      />
    </span>
  );
}

export function AgentProviderIcon({
  agent,
  className = "size-3.5",
}: {
  agent: string | null | undefined;
  className?: string;
}) {
  const source = agentIconSource(agent);
  if (source === "t3") {
    const kind = canonicalAgentKind(agent);
    const spec = kind === null ? null : agentIconSpec(kind);
    if (spec) return <T3BrandIcon spec={spec} className={className} />;
  }
  const svgUrl = bundledAgentIconUrl(agent);
  if (svgUrl) return <SvgAssetIcon url={svgUrl} className={className} />;
  return <GenericAgentIcon className={className} />;
}
