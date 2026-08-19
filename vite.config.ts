import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// Multi-page shell: index.html = main window chrome, splash.html = launch animation.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: [
        "**/src-tauri/**",
        "**/plugins/**",
        "**/.*/**",
        "**/*.tmp",
        "**/.*.tmpdir/**",
      ],
    },
  },
  build: {
    rollupOptions: {
      input: {
        shell: resolve(__dirname, "index.html"),
        splash: resolve(__dirname, "splash.html"),
        trayMenu: resolve(__dirname, "tray-menu.html"),
      },
    },
  },
});
