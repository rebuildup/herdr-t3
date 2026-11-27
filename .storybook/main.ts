import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import type { StorybookConfig } from "@storybook/react-vite";

const config: StorybookConfig = {
  stories: ["../src/**/*.stories.@(ts|tsx)"],
  framework: "@storybook/react-vite",
  // Storybook runs its own Vite server and does not pick up vite.config.ts,
  // so the project alias and the Tailwind v4 plugin are wired here.
  viteFinal: async (viteConfig) => {
    viteConfig.plugins = [...(viteConfig.plugins ?? []), react(), tailwindcss()];
    const existing = viteConfig.resolve?.alias;
    const entries = Array.isArray(existing)
      ? existing
      : Object.entries(existing ?? {}).map(([find, replacement]) => ({
          find,
          replacement: replacement as string,
        }));
    viteConfig.resolve = {
      ...viteConfig.resolve,
      alias: [
        ...entries,
        { find: "~", replacement: fileURLToPath(new URL("../src", import.meta.url)) },
      ],
    };
    return viteConfig;
  },
};

export default config;
