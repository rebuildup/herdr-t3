import { cx } from "class-variance-authority";
import { extendTailwindMerge } from "tailwind-merge";

// Register extra font sizes so tailwind-merge does not treat text-2xs..5xs
// as colors (same extension T3 Code applies in apps/web/src/lib/utils.ts).
const twMerge = extendTailwindMerge({
  extend: {
    theme: { text: ["2xs", "3xs", "4xs", "5xs"] },
  },
});

export function cn(...inputs: Parameters<typeof cx>) {
  return twMerge(cx(inputs));
}

/* Platform helpers ported from t3code apps/web/src/lib/utils.ts (MIT). */

export function isMacPlatform(platform: string): boolean {
  return /mac|iphone|ipad|ipod/i.test(platform);
}

export function isWindowsPlatform(platform: string): boolean {
  return /^win(dows)?/i.test(platform);
}
