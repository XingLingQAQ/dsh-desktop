import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// Multi-page shell: index.html = main window chrome, splash.html = launch
// animation, tray-menu.html / update-popup.html = the two small always-on-top
// windows (see lib.rs for why the updater gets a window of its own).
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
        updatePopup: resolve(__dirname, "update-popup.html"),
      },
    },
  },
});
