/**
 * The desktop pet — the always-present little companion that lives on the
 * desktop after the main window is closed.
 *
 * Phase one is deliberately just the pet itself: it renders, it blinks and
 * breathes, it can be dragged around, and it remembers where it was put. The
 * conversation and file features arrive in later phases on top of this shell.
 *
 * Two decisions worth stating:
 *
 *  * **Dragging is done by the window manager**, not by tracking pointer
 *    position in the page. `startDragging()` hands the drag to the OS, which is
 *    what makes the window follow the cursor smoothly and what makes a drop on
 *    another monitor behave. Doing it in the page means fighting the compositor
 *    for every frame.
 *  * **The animation is CSS, not a sprite sheet or a renderer.** A pet that
 *    needs an asset pipeline before it can blink is a pet that never ships. The
 *    drawing is a few inline shapes; the motion is keyframes. Art can replace
 *    this later without changing anything around it.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { applyTheme, fetchTheme, type ThemeSnapshot } from "./theme";
import "./styles.css";

/** Moods the pet can be in. Phase one is idle-only plus a poke reaction. */
type Mood = "idle" | "happy";

/**
 * How long a poke reaction lasts before settling back to idle.
 *
 * Short on purpose: the pet is meant to feel like it noticed you, not like it is
 * waiting for you to keep interacting.
 */
const POKE_MS = 1100;

function Pet() {
  const [mood, setMood] = useState<Mood>("idle");
  // The blink timer is cleared on unmount, and the reaction's timer is too — a
  // transparent always-on-top window that keeps waking up to flip a class is a
  // battery cost for no visible benefit.
  const reaction = useRef<number | null>(null);

  useEffect(() => {
    // This window is built at startup with the rest of the shell, possibly
    // before the DSH page has reported a theme, so it asks for the last
    // snapshot rather than waiting for a change that may never come.
    void fetchTheme();
    const un = listen<ThemeSnapshot>("theme-changed", (event) => {
      applyTheme(event.payload);
    });
    return () => {
      un.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    return () => {
      if (reaction.current !== null) window.clearTimeout(reaction.current);
    };
  }, []);

  const poke = useCallback(() => {
    setMood("happy");
    if (reaction.current !== null) window.clearTimeout(reaction.current);
    reaction.current = window.setTimeout(() => setMood("idle"), POKE_MS);
  }, []);

  const menu = useCallback(() => {
    void invoke("show_pet_menu");
  }, []);

  /**
   * Drag the window with the OS.
   *
   * A plain click and a drag both start here, so the reaction fires on
   * mouse-up only when the pointer barely moved — otherwise every drag would
   * also poke the pet, which reads as the pet celebrating being moved.
   */
  const startDrag = useCallback((event: React.MouseEvent) => {
    if (event.button !== 0) return;
    const startX = event.clientX;
    const startY = event.clientY;
    const onUp = (up: MouseEvent) => {
      window.removeEventListener("mouseup", onUp);
      const moved = Math.hypot(up.clientX - startX, up.clientY - startY);
      if (moved < 4) poke();
    };
    window.addEventListener("mouseup", onUp);
    // On Windows this resolves when the OS drag loop ends, which is the first
    // moment the final position is known. The shell also saves once the window
    // stops moving, so this is only about landing it sooner — if the promise
    // resolves early instead, that path still stores the right value.
    void getCurrentWindow()
      .startDragging()
      .then(() => invoke("pet_save_position"))
      .catch(() => {});
  }, [poke]);

  return (
    <div className="pet-root" data-mood={mood}>
      {/* The whole body is the drag handle and the poke target. */}
      <div
        className="pet-body"
        role="button"
        tabIndex={0}
        aria-label="桌面宠物，拖动可移动，点击有反应"
        onMouseDown={startDrag}
        onContextMenu={(event) => {
          event.preventDefault();
          menu();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            poke();
          }
        }}
      >
        <div className="pet-shadow" aria-hidden="true" />
        <div className="pet-figure" aria-hidden="true">
          <div className="pet-ear pet-ear-left" />
          <div className="pet-ear pet-ear-right" />
          <div className="pet-head">
            <div className="pet-eye pet-eye-left" />
            <div className="pet-eye pet-eye-right" />
            <div className="pet-cheek pet-cheek-left" />
            <div className="pet-cheek pet-cheek-right" />
            <div className="pet-mouth" />
          </div>
          <div className="pet-belly" />
        </div>
        {/* A sparkle that only exists during the reaction, so nothing has to be
            animated while the pet is idle. */}
        <div className="pet-sparkle" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Pet />
  </React.StrictMode>,
);
