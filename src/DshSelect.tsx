import { useEffect, useRef, useState } from "react";

/**
 * A select in DSH's own idiom.
 *
 * The native `<select>` cannot be styled into this: the popup it opens is drawn
 * by Windows, so its surface, radius and row height ignore everything the page
 * says. DSH's own menus are a 12px-radius card on the menu surface with 40px
 * rows and a trailing check, so this reproduces that rather than fighting the
 * platform control.
 *
 * The list is absolutely positioned inside the popup's scroll container instead
 * of portalled: the window resizes to the card, so the panel always fits, and
 * portalling would need coordinates recomputed on every resize for no gain.
 */
export type Choice = { value: string; label: string };

export function DshSelect({
  value,
  choices,
  disabled,
  onChange,
}: {
  value: string;
  choices: Choice[];
  disabled?: boolean;
  onChange: (next: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);
  const selected = choices.find((choice) => choice.value === value) ?? choices[0];

  // A menu closes on the same gestures as a native one: Escape, or a click
  // anywhere outside — including the trigger itself, which toggles.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (root.current !== null && !root.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pick = (next: string) => {
    setOpen(false);
    if (next !== value) onChange(next);
  };

  return (
    <div className="upd-select" ref={root}>
      <button
        type="button"
        className="upd-selectTrigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled === true}
        onClick={() => setOpen((was) => !was)}
      >
        <span className="upd-selectLabel">{selected?.label ?? value}</span>
        <svg className="upd-caret" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M3 5 L6 8 L9 5" fill="none" stroke="currentColor" />
        </svg>
      </button>
      {open && (
        <div className="upd-selectList" role="listbox">
          {choices.map((choice) => (
            <button
              key={choice.value}
              type="button"
              role="option"
              aria-selected={choice.value === value}
              className="upd-selectItem"
              onClick={() => pick(choice.value)}
            >
              <span className="upd-selectItemLabel">{choice.label}</span>
              {choice.value === value && (
                <svg className="upd-selectCheck" viewBox="0 0 12 12" aria-hidden="true">
                  <path d="M2.5 6.4 L5 8.8 L9.5 3.6" fill="none" stroke="currentColor" />
                </svg>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
