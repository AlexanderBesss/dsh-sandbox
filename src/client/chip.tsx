import { DOT, PillButton, copyText, useCopied, useSandboxStatus } from "./pill.tsx"

export interface ContainerChipProps {
  sessionId: string
}

function row(label: string, value: string | undefined): string {
  return value === undefined || value === "" ? "" : `${label}: ${value}\n`
}

const DOT_BY_STATE = {
  ready: DOT.success,
  error: DOT.error,
  absent: DOT.idle,
  pending: DOT.warn,
} as const

export function ContainerChip({ sessionId }: ContainerChipProps) {
  const { status, error } = useSandboxStatus(sessionId)
  const { copied, markCopied } = useCopied()

  const copy = () => {
    if (status === undefined) return
    copyText(status.container, markCopied)
  }

  const state = status === undefined
    ? error === undefined ? "pending" : "error"
    : status.ready ? "ready" : status.phase === "absent" ? "absent" : "pending"

  const dotColor = DOT_BY_STATE[state]

  const label = status?.container ?? (error === undefined ? "sandbox…" : "sandbox")

  const title = [
    status === undefined ? "" : `container ${status.container}\n`,
    status === undefined ? "" : `phase ${status.phase} · image ${status.image}\n`,
    status === undefined ? "" : row("workspace", status.worktree?.path ?? status.workspace),
    status === undefined ? "" : row("mounted at", status.containerWorkspace),
    status?.worktree === undefined ? "" : `branch ${status.worktree.branch}${status.worktree.dirty ? " (dirty)" : ""}\n`,
    status?.worktree === undefined ? "" : row("carved from", status.worktree.mainWorkspace),
    status?.worktreeError === undefined ? "" : `worktree failed: ${status.worktreeError}\n`,
    error === undefined ? "" : `unavailable: ${error}\n`,
    copied ? "copied" : "click to copy the container name",
  ].join("")

  return (
    <PillButton
      label={copied ? "copied" : label}
      title={title}
      dotColor={dotColor}
      onClick={copy}
    />
  )
}
