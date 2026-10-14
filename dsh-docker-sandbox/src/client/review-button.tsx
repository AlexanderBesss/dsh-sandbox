import { useCallback, useState } from "react"
import { requestReview, type ReviewView, type WorktreeView } from "./api.ts"
import { PillButton, phaseDotColor, useSandboxStatus, type PillPhase } from "./pill.tsx"

export interface ReviewButtonProps {
  sessionId: string
}

export function ReviewButton({ sessionId }: ReviewButtonProps) {
  const { status } = useSandboxStatus(sessionId)
  const worktree: WorktreeView | undefined = status?.worktree
  const [phase, setPhase] = useState<PillPhase>("idle")
  const [result, setResult] = useState<ReviewView | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)

  const act = useCallback(() => {
    if (phase === "busy") return
    setPhase("busy")
    setError(undefined)
    void requestReview(sessionId).then(
      (next) => {
        setResult(next)
        setPhase("done")
      },
      (cause: unknown) => {
        setError((cause as Error).message)
        setPhase("error")
      },
    )
  }, [phase, sessionId])

  if (worktree === undefined) return null

  const label = phase === "busy"
    ? "reviewing…"
    : phase === "done"
      ? "review started"
      : phase === "error"
        ? "retry review"
        : "review"

  const title = [
    `branch ${worktree.branch}\n`,
    worktree.dirty ? "uncommitted changes will be reviewed\n" : "",
    worktree.unpushed ? "unpushed commits will be reviewed\n" : "",
    result?.childSessionId === undefined ? "" : `review session: ${result.childSessionId}\n`,
    error === undefined ? "" : `failed: ${error}\n`,
    phase === "done"
      ? "the reviewer runs in its own child session"
      : "spawn a fresh reviewer with no memory of this chat, reviewing only this session's changes",
  ].join("")

  return (
    <PillButton
      label={label}
      title={title}
      dotColor={phaseDotColor(phase)}
      onClick={act}
      disabled={phase === "busy"}
    />
  )
}
