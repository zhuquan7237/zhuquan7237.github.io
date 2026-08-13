import { defineConfig, type Plugin } from "vitest/config";
import react from "@vitejs/plugin-react";
import { createLocalAgentPlugin } from "./server/vite-plugin";

function localAgentPlugin(): Plugin {
  return createLocalAgentPlugin();
}

export default defineConfig({
  base: "./",
  plugins: [react(), localAgentPlugin()],
  build: {
    outDir: "../app",
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    port: 4173,
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
