import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Dev profile default: the dev bridge (scripts/dev.sh) listens on 4738 so a
// stable install on 4737 is never claimed by accident.
const bridgePort = Number(process.env.HERDR_T3_PORT ?? 4738);

export default defineConfig(({ command }) => ({
  // The desktop app loads dist/ over file://, so built assets must be
  // relative; the dev server keeps absolute paths for HMR.
  base: command === "serve" ? "/" : "./",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "~": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 5737,
    // Pre-transform the client entry graph at server start: the UI
    // verification harness (scripts/ui-electron.sh) requires the app to
    // reach operable state within a strict budget, and on-demand
    // transform of the module graph otherwise dominates cold start.
    warmup: {
      // Warm the whole client graph, not just the entry: lazy routes and
      // deep imports still transform on demand otherwise, and the UI
      // verification harness's spawn->operable deadline is measured
      // against the real page load.
      clientFiles: ["./src/main.tsx", "./src/**/*.ts", "./src/**/*.tsx"],
    },
    proxy: {
      "/api": `http://127.0.0.1:${bridgePort}`,
      "/ws": { target: `ws://127.0.0.1:${bridgePort}`, ws: true },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
    // The packaged app loads dist/ over file://, where fetch() of a file URL is
    // refused; inlining the terminal engine's wasm as a data URI keeps it
    // loadable there (and everywhere else). It is the only asset this large.
    assetsInlineLimit: (filePath) => (filePath.endsWith(".wasm") ? true : undefined),
  },
}));
