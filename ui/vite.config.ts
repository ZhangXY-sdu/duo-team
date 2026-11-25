import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";
import path from "node:path";

export default defineConfig({
  root: path.resolve(__dirname),
  plugins: [react(), viteSingleFile()],
  build: {
    outDir: path.resolve(__dirname, "../dist/ui"),
    emptyOutDir: true,
    assetsInlineLimit: 100000000,
    rollupOptions: {
      input: path.resolve(__dirname, "workbench.html"),
    },
  },
});
