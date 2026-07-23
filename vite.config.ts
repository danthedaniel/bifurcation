import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // GitHub Pages serves project sites at https://<user>.github.io/<repo>/,
  // so the asset base path must match the repo name.
  base: "/bifurcation/",
  build: {
    outDir: "docs",
    emptyOutDir: true,
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // Mirror the "~/*" -> repo root alias from tsconfig.json so imports like
      // "~/components/..." keep working.
      "~": rootDir,
    },
  },
});
