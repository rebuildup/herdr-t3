/*
 * Agent harness brand icon for sidebar rows and hover cards (issues #198,
 * #311). Resolution order: T3 Code provider artwork vendored in
 * agentIconData.ts, then official ACP Registry SVGs bundled in
 * agent-icons/ (agentIconUrls.ts), then a generic agent glyph — the
 * initials tile fallback is gone (issue #311: icon-only display).
 */
import { Bot } from "lucide-react";
import { useId, useState } from "react";

import { cn } from "~/lib/utils";
import { AGENT_ICON_DATA, type AgentIconSpec } from "./agentIconData";
import { acpAgentIconUrl } from "./agentIconUrls";

export function agentIconSpec(agent: string | null | undefined): AgentIconSpec | null {
  const key = agent?.trim().toLowerCase();
  return key ? (AGENT_ICON_DATA[key] ?? null) : null;
}

/**
 * Whether the agent kind resolves to a brand mark (T3 artwork or a
 * vendored ACP Registry icon) rather than the generic glyph. The sidebar
 * uses this to decide whether repeating the harness id as row meta is
 * redundant (issue #204 review).
 */
export function hasAgentBrandIcon(agent: string | null | undefined): boolean {
  return agentIconSpec(agent) !== null || acpAgentIconUrl(agent) !== null;
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

// ACP Registry glyphs are monochrome `currentColor` SVGs; rendered through
// an <img> they cannot inherit the page color, so a local SVG filter
// recolors every painted pixel to currentColor — the same trick T3's
// AcpRegistryAgentIcon uses (AcpRegistryIcon.tsx @ 9cc4018c). The filter
// id is per-instance because filter ids are document-global.
function AcpRegistryIcon({
  url,
  className,
}: {
  url: string;
  className: string | undefined;
}) {
  const filterId = useId();
  const [failed, setFailed] = useState(false);
  if (failed) return <GenericAgentIcon className={className} />;
  return (
    <span className="relative inline-flex shrink-0 items-center justify-center">
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
        className={cn("shrink-0", className)}
        style={{ filter: `url(#${filterId})` }}
        onError={() => setFailed(true)}
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
  const spec = agentIconSpec(agent);
  if (spec) return <T3BrandIcon spec={spec} className={className} />;
  const acpUrl = acpAgentIconUrl(agent);
  if (acpUrl) return <AcpRegistryIcon url={acpUrl} className={className} />;
  return <GenericAgentIcon className={className} />;
}
