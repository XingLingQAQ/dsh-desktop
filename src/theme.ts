// 主题联动：把 DSH 页面上报的 --dsw-alias-* 主题快照映射到壳的 CSS 变量。
// 默认值 = DSH 浅色主题的真实色值（design-platform.css），深色值由上报覆盖。

import { invoke } from "@tauri-apps/api/core";

export interface ThemeSnapshot {
  dark: boolean;
  vars: Record<string, string>;
}

const MAPPING: Array<[string, string]> = [
  ["--ds-bg-base", "--dsw-alias-bg-base"],
  ["--ds-bg-1", "--dsw-alias-bg-layer-1"],
  ["--ds-bg-2", "--dsw-alias-bg-layer-2"],
  ["--ds-overlay", "--dsw-alias-bg-overlay"],
  ["--ds-border", "--dsw-alias-border-l1"],
  ["--ds-border-2", "--dsw-alias-border-l2"],
  ["--ds-brand", "--dsw-alias-brand-primary"],
  ["--ds-brand-invert", "--dsw-alias-label-primary-inverted"],
  ["--ds-label", "--dsw-alias-label-primary"],
  ["--ds-label-2", "--dsw-alias-label-secondary"],
  ["--ds-label-3", "--dsw-alias-label-tertiary"],
  ["--ds-tb-bg", "--dsw-specific-sidebar-fill"],
  ["--ds-success", "--dsw-alias-state-success-primary"],
  ["--ds-error", "--dsw-alias-state-error-primary"],
  ["--ds-warn", "--dsw-alias-state-warn-primary"],
  ["--ds-hover", "--dsw-alias-interactive-bg-hover"],
  ["--ds-font-mono", "--dsw-font-markdown-code-font-family"],
];

/**
 * Pull the theme the DSH page last reported.
 *
 * The page only reports on *change*, so a window opened after it settled — the
 * update popup, the tray menu — would otherwise render on the compiled-in light
 * defaults whatever the app is wearing. Windows call this on mount and then
 * keep listening for `theme-changed`.
 */
export async function fetchTheme(): Promise<void> {
  try {
    const snapshot = await invoke<ThemeSnapshot | null>("get_theme");
    if (snapshot !== null) applyTheme(snapshot);
  } catch {
    /* no theme reported yet, or an older shell without the command */
  }
}

export function applyTheme(snapshot: ThemeSnapshot): void {
  const root = document.documentElement;
  for (const [ours, theirs] of MAPPING) {
    const value = snapshot.vars[theirs];
    if (value) root.style.setProperty(ours, value);
  }
  root.dataset.theme = snapshot.dark ? "dark" : "light";
}
