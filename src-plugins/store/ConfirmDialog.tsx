/**
 * DSH-styled confirmation dialog for destructive store/manager actions.
 *
 * Wraps the platform `Modal` primitive (the same r24 card + blurred mask every
 * DSH dialog uses) instead of `window.confirm`, whose native chrome clashes
 * with the themed settings pane. The store plugin may value-import ui-primitives
 * — it is a platform word — so the dialog inherits theme tokens for free.
 *
 * Usage is promise-shaped so call sites keep their linear flow:
 *   const ok = await confirmDialog.open({ title, description })
 */

import { useCallback, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Button, IconWarningOutline16, Modal } from '@deepseek-ai/dsh-client-ui-primitives'

export interface ConfirmOptions {
  title: string
  /** Supporting sentence(s) rendered under the title. */
  description: string
  confirmLabel?: string
  cancelLabel?: string
}

interface DialogProps extends ConfirmOptions {
  onResolve: (ok: boolean) => void
}

function ConfirmDialog({ title, description, confirmLabel = '确定', cancelLabel = '取消', onResolve }: DialogProps): React.ReactElement {
  const [open, setOpen] = useState(true)
  const settle = useCallback((ok: boolean) => {
    setOpen(false)
    onResolve(ok)
  }, [onResolve])

  return (
    <Modal
      open={open}
      onClose={() => { settle(false) }}
      title={title}
      closeLabel="关闭"
      description={description}
      footer={(
        <>
          <Button variant="outline" onClick={() => { settle(false) }}>
            {cancelLabel}
          </Button>
          <Button variant="primary" autoFocus onClick={() => { settle(true) }}>
            {confirmLabel}
          </Button>
        </>
      )}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--dsw-alias-label-secondary)' }}>
        <IconWarningOutline16 size={16} />
      </div>
    </Modal>
  )
}

/**
 * Open one confirmation dialog and resolve with the user's choice.
 * Mounts a transient React root over the page body; unmounts on close.
 */
export function openConfirm(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const done = (ok: boolean) => {
      // Give the Modal's exit frame a tick before tearing the root down.
      setTimeout(() => {
        root.unmount()
        host.remove()
      }, 0)
      resolve(ok)
    }
    root.render(<ConfirmDialog {...options} onResolve={done} />)
  })
}
