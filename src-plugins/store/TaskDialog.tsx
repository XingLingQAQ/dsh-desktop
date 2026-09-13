/**
 * DSH-styled progress and error dialogs for the store's long-running actions.
 *
 * Install / update / uninstall / takeover each reach the bridge as a single POST
 * that only answers once the work is done, so there is no real progress to show:
 * the bar is deliberately indeterminate rather than a fabricated percentage.
 * What the dialog does carry is the step it is on, how long it has been running,
 * and — when the action fails — the bridge's own message in something the user
 * cannot miss. The inline error line under the list was easy to scroll past, and
 * a failed install that looks like a silent no-op is the worst of both.
 *
 * Both helpers are promise-shaped so call sites keep their linear flow:
 *   const ok = await runTask({ title, step, run: async report => { … } })
 *   await openAlert({ title, description })
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Button, IconWarningOutline16, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { readProgress, type TaskProgress } from './data.ts'

/**
 * Update the dialog while the task runs.
 * @param label - step text under the bar.
 * @param progressId - plugin whose bridge-side byte progress to follow from now
 *   on; a batch passes a new id per plugin.
 * @param description - replaces the sentence under the title (a batch's
 *   「(2/3) plugin-id」 lives here so the step line stays free for the phase).
 */
export type ReportStep = (label: string, progressId?: string, description?: string) => void

export interface TaskOptions {
  title: string
  /** Step label shown until `run` reports another one. */
  step: string
  /** Supporting sentence under the title. */
  description?: string
  /**
   * Plugin id whose bridge-side progress to poll. Supplying it turns the bar
   * determinate while the download reports bytes; without it the bar stays a
   * sweep, which is all an action with no measurable middle can honestly show.
   */
  progressId?: string
  /** The work itself. Throwing surfaces the message in the dialog. */
  run: (report: ReportStep) => Promise<void>
}

/** `12345678` → `11.8 MB`. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(0)} KB`
  return `${(kb / 1024).toFixed(1)} MB`
}

function phaseLabel(phase: string | undefined): string | undefined {
  switch (phase) {
    case 'download': return '正在下载…'
    case 'extract': return '正在解压…'
    case 'install': return '正在安装…'
    default: return undefined
  }
}

export interface AlertOptions {
  title: string
  description?: string
  /** Verbatim detail (an error message) rendered in a selectable block. */
  detail?: string
  closeLabel?: string
}

/** Mount a transient React root over the page body and tear it down on close. */
function mountDialog(render: (done: () => void) => React.ReactElement): void {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const done = () => {
    // Give the Modal's exit frame a tick before tearing the root down.
    setTimeout(() => {
      root.unmount()
      host.remove()
    }, 0)
  }
  root.render(render(done))
}

/** Seconds since mount, surfaced only once an action stops feeling instant. */
function useElapsed(): number {
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    const started = Date.now()
    const timer = setInterval(() => {
      setElapsed(Math.floor((Date.now() - started) / 1000))
    }, 1000)
    return () => { clearInterval(timer) }
  }, [])
  return elapsed
}

/** Poll the bridge for byte progress while the action is in flight. */
function useProgress(progressId: string | undefined, active: boolean): TaskProgress | undefined {
  const [live, setLive] = useState<TaskProgress | undefined>(undefined)
  useEffect(() => {
    if (progressId === undefined || !active) return
    let stopped = false
    const tick = async () => {
      const next = await readProgress(progressId)
      if (!stopped) setLive(next)
    }
    void tick()
    const timer = setInterval(() => { void tick() }, 300)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [progressId, active])
  return live
}

interface TaskViewProps extends TaskOptions {
  onSettled: (ok: boolean) => void
}

function TaskView({ title, step, description, progressId, run, onSettled }: TaskViewProps): React.ReactElement {
  const [label, setLabel] = useState(step)
  const [note, setNote] = useState(description)
  const [activeId, setActiveId] = useState(progressId)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [open, setOpen] = useState(true)
  const elapsed = useElapsed()
  const running = failure === undefined
  const live = useProgress(activeId, running)
  // The task must start exactly once, even under StrictMode's double-invoke.
  const started = useRef(false)

  const close = useCallback((ok: boolean) => {
    setOpen(false)
    onSettled(ok)
  }, [onSettled])

  useEffect(() => {
    if (started.current) return
    started.current = true
    void (async () => {
      try {
        await run((next, nextId, nextNote) => {
          setLabel(next)
          if (nextId !== undefined) setActiveId(nextId)
          if (nextNote !== undefined) setNote(nextNote)
        })
        close(true)
      } catch (reason) {
        setFailure(reason instanceof Error ? reason.message : String(reason))
      }
    })()
  }, [run, close])

  // While the bridge reports a phase it owns the label; once it stops reporting,
  // whatever the task last said (「正在刷新列表…」) takes over again.
  const bridgeLabel = live?.running === true ? phaseLabel(live.phase) : undefined
  const total = live?.running === true ? live.total ?? 0 : 0
  const received = live?.received ?? 0
  const percent = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : undefined

  return (
    <Modal
      open={open}
      // Dismissal is refused while the work is in flight: closing the dialog
      // would not cancel the bridge call, so it could only hide it.
      onClose={() => { if (!running) close(false) }}
      title={title}
      closeLabel="关闭"
      description={running ? note : undefined}
      footer={running
        ? <Button variant="outline" disabled>请稍候…</Button>
        : <Button variant="primary" autoFocus onClick={() => { close(false) }}>关闭</Button>}
    >
      {running
        ? (
          <div className="dsx-task">
            <div
              className="dsx-task-bar"
              role="progressbar"
              aria-label={bridgeLabel ?? label}
              aria-valuenow={percent}
              aria-valuemin={percent === undefined ? undefined : 0}
              aria-valuemax={percent === undefined ? undefined : 100}
            >
              <div
                className={percent === undefined ? 'dsx-task-bar-fill' : 'dsx-task-bar-fill is-determinate'}
                style={percent === undefined ? undefined : { width: `${String(percent)}%` }}
              />
            </div>
            <div className="dsx-task-step">
              <span>{bridgeLabel ?? label}</span>
              <span className="dsx-task-elapsed">
                {percent === undefined
                  ? (elapsed >= 3 ? `${String(elapsed)}s` : '')
                  : `${formatBytes(received)} / ${formatBytes(total)} · ${String(percent)}%`}
              </span>
            </div>
          </div>
        )
        : (
          <div className="dsx-task-error">
            <div className="dsx-task-error-head">
              <IconWarningOutline16 size={16} />
              <span>操作未完成</span>
            </div>
            <pre className="dsx-task-error-detail">{failure}</pre>
          </div>
        )}
    </Modal>
  )
}

/**
 * Run one long action behind a progress dialog.
 * @returns `true` when it finished, `false` when it failed (the dialog said so).
 */
export function runTask(options: TaskOptions): Promise<boolean> {
  return new Promise((resolve) => {
    mountDialog(done => (
      <TaskView
        {...options}
        onSettled={(ok) => {
          done()
          resolve(ok)
        }}
      />
    ))
  })
}

function AlertView({ title, description, detail, closeLabel = '知道了', onClose }:
AlertOptions & { onClose: () => void }): React.ReactElement {
  const [open, setOpen] = useState(true)
  const settle = useCallback(() => {
    setOpen(false)
    onClose()
  }, [onClose])

  return (
    <Modal
      open={open}
      onClose={settle}
      title={title}
      closeLabel="关闭"
      description={description}
      footer={<Button variant="primary" autoFocus onClick={settle}>{closeLabel}</Button>}
    >
      <div className="dsx-task-error">
        <div className="dsx-task-error-head">
          <IconWarningOutline16 size={16} />
          <span>出错了</span>
        </div>
        {detail === undefined ? null : <pre className="dsx-task-error-detail">{detail}</pre>}
      </div>
    </Modal>
  )
}

/** Report a failure the user has to acknowledge, in the same card every DSH dialog uses. */
export function openAlert(options: AlertOptions): Promise<void> {
  return new Promise((resolve) => {
    mountDialog(done => (
      <AlertView
        {...options}
        onClose={() => {
          done()
          resolve()
        }}
      />
    ))
  })
}
