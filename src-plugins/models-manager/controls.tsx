/**
 * The two controls both settings pages need and the platform does not ship: an
 * icon-only action that names itself on hover, and a select built from the
 * platform's own `Menu`.
 *
 * `Button` cannot host a tooltip — React 18 gives a ref only to a DOM element,
 * and `Tooltip` positions its bubble from its anchor's ref — so the anchor here
 * is a plain <button> styled from the same tokens `Button.module.css` uses.
 * The unavailable state is `aria-disabled`, not `disabled`: a disabled form
 * control delivers none of the hover or focus events the tooltip needs.
 *
 * `Chooser` exists because the platform ships no select atom and a native
 * `<select>` draws its own list, which no stylesheet can reach. The trigger is
 * sized to the platform's `Input` (32px, 8px radius, 14px type) so a dropdown
 * and a text field read as one control set; `variant="dense"` is the same
 * control at the MCP form's tighter scale.
 */

import { useState, type ReactNode } from 'react'
import {
  IconChevronDownOutline14, Menu, Tooltip, type TooltipSide,
} from '@deepseek-ai/dsh-client-ui-primitives'

/** One option of a {@link Chooser}. */
export interface Choice<T extends string> {
  value: T
  label: string
}

/**
 * Render an icon-only button that names itself on hover.
 * @param props.label - tooltip text, and the button's accessible name.
 * @param props.icon - the 16px glyph.
 * @param props.onClick - fired on click; not wired while `disabled`.
 * @param props.disabled - shown dimmed and inert, but still hoverable.
 * @param props.tone - colors the glyph: `danger` for destructive, `accent` for
 *   the surface's primary action.
 * @param props.side - bubble placement.
 */
export function IconAction({ label, icon, onClick, disabled = false, tone, side = 'bottom' }: {
  label: string
  icon: ReactNode
  onClick: () => void
  disabled?: boolean
  tone?: 'danger' | 'accent'
  side?: TooltipSide
}): ReactNode {
  return (
    <Tooltip label={label} side={side}>
      <button
        type="button"
        className="dsx-iconButton"
        data-tone={tone}
        aria-label={label}
        aria-disabled={disabled ? true : undefined}
        onClick={disabled ? undefined : onClick}
      >
        {icon}
      </button>
    </Tooltip>
  )
}

/**
 * Render a select over the platform's dropdown menu.
 *
 * Portaled on purpose: the callers sit inside a dialog card or a scrolling
 * panel, and an in-place list would be clipped by an ancestor. The list's own
 * z-index keeps it above a modal mask.
 * @param props.value - the selected option id; `''` is a real option (the
 *   caller's "unset" row), not a placeholder.
 * @param props.options - the offered options, current one marked in the list.
 * @param props.onChange - fired with the picked value.
 * @param props.label - accessible name; the trigger shows the value instead.
 * @param props.className - sizing class; the trigger fills whatever it gives.
 * @param props.variant - `dense` for the tight form scale, default otherwise.
 * @param props.disabled - shown dimmed and inert.
 */
export function Chooser<T extends string>({ value, options, onChange, className, label, variant = 'default', disabled = false }: {
  value: T
  options: readonly Choice<T>[]
  onChange: (value: T) => void
  className?: string | undefined
  label: string
  variant?: 'default' | 'dense'
  disabled?: boolean
}): ReactNode {
  const [open, setOpen] = useState(false)
  const current = options.find(option => option.value === value)
  return (
    <Menu
      open={open}
      onClose={() => { setOpen(false) }}
      items={options.map(option => ({ id: option.value, label: option.label }))}
      selectedId={value}
      onSelect={(id) => { setOpen(false); onChange(id as T) }}
      compact
      portal
      className={className}
      anchor={(
        <button
          type="button"
          className="dsx-choice"
          data-variant={variant === 'dense' ? 'dense' : undefined}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={label}
          disabled={disabled}
          onClick={() => { setOpen(!open) }}
        >
          <span className="dsx-choiceLabel">{current?.label ?? ''}</span>
          <IconChevronDownOutline14 className="dsx-choiceChevron" />
        </button>
      )}
    />
  )
}
