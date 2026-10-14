import { useCallback, useEffect, useState } from "react"
import { cancelSubagent, fetchSandboxStatus, type SandboxStatusView, type SubagentKind } from "./api.ts"

const POLL_MS = 15000
const COPIED_RESET_MS = 1500

export const DOT = {
  success: "var(--dsw-alias-state-success-primary)",
  error: "var(--dsw-alias-state-error-primary)",
  warn: "var(--dsw-alias-state-warn-primary)",
  idle: "var(--dsw-alias-state-idle-primary)",
} as const

export type PillPhase = "idle" | "busy" | "done" | "error"

export function phaseDotColor(phase: PillPhase): string {
  return phase === "done"
    ? DOT.success
    : phase === "error"
      ? DOT.error
      : phase === "busy"
        ? DOT.warn
        : DOT.idle
}

interface StatusSnapshot {
  status?: SandboxStatusView
  error?: string
}

interface Poller {
  listeners: Set<(snapshot: StatusSnapshot) => void>
  snapshot: StatusSnapshot
  timer?: ReturnType<typeof setInterval>
}

// One poll per session, shared by every header pill: each status call fans out
// into several git invocations on the host, and one poll per pill would
// multiply them.
const pollers = new Map<string, Poller>()

export function useSandboxStatus(sessionId: string): StatusSnapshot {
  const [snapshot, setSnapshot] = useState<StatusSnapshot>({})

  useEffect(() => {
    let poller = pollers.get(sessionId)
    if (poller === undefined) {
      const shared: Poller = { listeners: new Set(), snapshot: {} }
      const load = async () => {
        try {
          const next = await fetchSandboxStatus(sessionId)
          shared.snapshot = { status: next, error: next.error }
        } catch (cause) {
          // Keep the last good status: the pills render nothing at all without a
          // worktree, so one failed poll would hide them for a whole interval.
          shared.snapshot = { ...shared.snapshot, error: (cause as Error).message }
        }
        for (const listener of shared.listeners) listener(shared.snapshot)
      }
      void load()
      shared.timer = setInterval(() => void load(), POLL_MS)
      pollers.set(sessionId, shared)
      poller = shared
    }
    const active = poller
    const listener = (next: StatusSnapshot) => setSnapshot(next)
    active.listeners.add(listener)
    setSnapshot(active.snapshot)
    return () => {
      active.listeners.delete(listener)
      if (active.listeners.size === 0) {
        clearInterval(active.timer)
        pollers.delete(sessionId)
      }
    }
  }, [sessionId])

  return snapshot
}

export interface SubagentRunState {
  running: boolean
  cancelling: boolean
  childSessionIds: string[]
  stop: () => void
  stopError?: string
}

// The host keeps every started child in a registry and reports it through the
// status poll, so a pill can stop a run this tab did not start — including one
// that survived a reload. `stopping` covers the window between the cancel
// request and the poll that shows the child gone.
export function useSubagentRun(
  status: SandboxStatusView | undefined,
  sessionId: string,
  kind: SubagentKind,
): SubagentRunState {
  const [stopping, setStopping] = useState(false)
  const [stopError, setStopError] = useState<string | undefined>(undefined)
  const held = (status?.subagents ?? []).filter((run) => run.kind === kind)
  const runningCount = held.length

  useEffect(() => {
    if (runningCount === 0) setStopping(false)
  }, [runningCount])

  const stop = useCallback(() => {
    if (stopping) return
    setStopping(true)
    setStopError(undefined)
    void cancelSubagent(sessionId, kind).then(
      () => undefined,
      (cause: unknown) => {
        setStopping(false)
        setStopError((cause as Error).message)
      },
    )
  }, [kind, sessionId, stopping])

  return {
    running: runningCount > 0,
    cancelling: stopping || held.some((run) => run.cancelling),
    childSessionIds: held.map((run) => run.childSessionId),
    stop,
    ...(stopError === undefined ? {} : { stopError }),
  }
}

export function useCopied(): { copied: boolean; markCopied: () => void } {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), COPIED_RESET_MS)
    return () => clearTimeout(timer)
  }, [copied])
  const markCopied = useCallback(() => setCopied(true), [])
  return { copied, markCopied }
}

export function copyText(text: string, markCopied: () => void): void {
  void navigator.clipboard?.writeText(text).then(markCopied, () => undefined)
}

export interface PillButtonProps {
  label: string
  title: string
  dotColor: string
  onClick: () => void
  disabled?: boolean
}

const pillBase = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  height: 22,
  padding: "0 8px",
  border: "1px solid var(--dsw-alias-border-l2)",
  borderRadius: 11,
  background: "var(--dsw-alias-bg-layer-1)",
  color: "var(--dsw-alias-label-secondary)",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 11,
  lineHeight: 1,
} as const

const pillLabel = {
  maxWidth: 180,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
} as const

function PillDot({ dotColor }: { dotColor: string }) {
  return (
    <span
      aria-hidden
      style={{
        width: 6,
        height: 6,
        borderRadius: "50%",
        background: dotColor,
        flex: "0 0 auto",
      }}
    />
  )
}

export function PillButton({ label, title, dotColor, onClick, disabled }: PillButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      disabled={disabled}
      style={{
        ...pillBase,
        cursor: disabled ? "wait" : "pointer",
      }}
    >
      <PillDot dotColor={dotColor} />
      <span style={pillLabel}>{label}</span>
    </button>
  )
}

export interface PillLinkProps {
  label: string
  title: string
  dotColor: string
  href: string
}

export function PillLink({ label, title, dotColor, href }: PillLinkProps) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      title={title}
      style={{
        ...pillBase,
        cursor: "pointer",
        textDecoration: "none",
      }}
    >
      <PillDot dotColor={dotColor} />
      <span style={pillLabel}>{label}</span>
    </a>
  )
}
