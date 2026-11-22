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
    proxy: {
      "/api": `http://127.0.0.1:${bridgePort}`,
      "/ws": { target: `ws://127.0.0.1:${bridgePort}`, ws: true },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
}));
