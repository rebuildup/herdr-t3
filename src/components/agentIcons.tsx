/*
 * Agent harness brand icon for sidebar rows and hover cards (issue #198).
 * Renders the T3 Code provider artwork vendored in agentIconData.ts; harnesses
 * without a brand asset get an initials tile, the same fallback T3 uses for
 * custom provider endpoints.
 */
import { useId } from "react";

import { cn } from "~/lib/utils";
import { AGENT_ICON_DATA, type AgentIconSpec } from "./agentIconData";

export function agentIconSpec(agent: string | null | undefined): AgentIconSpec | null {
  const key = agent?.trim().toLowerCase();
  return key ? (AGENT_ICON_DATA[key] ?? null) : null;
}

// Port of T3 `providerInstanceInitials`
// (packages/client-runtime/src/state/providerInstanceDisplay.ts):
// punctuation separates words, interior apostrophes stay, a lone
// camel-case word splits at its humps, one word yields its first two
// letters, several yield one letter each.
export function agentInitials(label: string): string {
  const toWords = (text: string) =>
    text
      .split(/\s+/u)
      .map((word) => word.replace(/^['’]+|['’]+$/gu, ""))
      .filter(Boolean);
  let words = toWords(label.replace(/[^\P{P}'’]+/gu, " "));
  if (words.length === 1) words = toWords(words[0]!.replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2"));
  if (words.length === 0) return "";
  if (words.length === 1) return Array.from(words[0]!).slice(0, 2).join("").toUpperCase();
  return words
    .slice(0, 2)
    .map((word) => Array.from(word)[0]?.toUpperCase() ?? "")
    .join("");
}

export function AgentProviderIcon({
  agent,
  name,
  className = "size-3.5",
}: {
  agent: string | null | undefined;
  name: string;
  className?: string;
}) {
  const spec = agentIconSpec(agent);
  const gradientId = useId();
  if (!spec) {
    // No brand asset: render the T3 initials fallback as a micro monogram
    // badge so it carries the same visual weight and footprint as the SVG
    // marks instead of reading as stray gray text (issue #204 review).
    return (
      <span
        className={cn(
          "inline-flex shrink-0 items-center justify-center rounded-sm border border-border/70 bg-muted/60 font-semibold leading-none text-foreground/75",
          className,
          "text-4xs",
        )}
        aria-hidden
      >
        {agentInitials(name)}
      </span>
    );
  }
  return (
    <svg
      viewBox={spec.viewBox}
      preserveAspectRatio="xMidYMid meet"
      fill="none"
      className={`shrink-0 fill-(--icon-light) dark:fill-(--icon-dark) ${className}`}
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
