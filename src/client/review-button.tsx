import { useCallback, useState } from "react"
import { requestReview, type ReviewView, type WorktreeView } from "./api.ts"
import {
  DOT,
  PillButton,
  phaseDotColor,
  useSandboxStatus,
  useSubagentRun,
  type PillPhase,
} from "./pill.tsx"

export interface ReviewButtonProps {
  sessionId: string
}

export function ReviewButton({ sessionId }: ReviewButtonProps) {
  const { status } = useSandboxStatus(sessionId)
  const worktree: WorktreeView | undefined = status?.worktree
  const [phase, setPhase] = useState<PillPhase>("idle")
  const [result, setResult] = useState<ReviewView | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const run = useSubagentRun(status, sessionId, "review")

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

  const childIds = [...new Set(
    [result?.childSessionId, ...run.childSessionIds].filter((id): id is string => id !== undefined && id !== ""),
  )]
  const failure = run.stopError ?? error

  const label = phase === "busy"
    ? "reviewing…"
    : run.running
      ? run.cancelling
        ? "stopping…"
        : "stop review"
      : phase === "done"
        ? "review started"
        : phase === "error"
          ? "retry review"
          : "review"

  const title = [
    `branch ${worktree.branch}\n`,
    worktree.dirty ? "uncommitted changes will be reviewed\n" : "",
    worktree.unpushed ? "unpushed commits will be reviewed\n" : "",
    ...childIds.map((id) => `review session: ${id}\n`),
    failure === undefined ? "" : `failed: ${failure}\n`,
    run.running
      ? run.cancelling
        ? "stopping the reviewer; the chat is told when it stops\n"
        : "click to stop the reviewer — it reports that it was stopped, and nothing it already read is undone\n"
      : phase === "done"
        ? "the reviewer runs in its own child session\n"
        : "spawn a fresh reviewer with no memory of this chat, reviewing only this session's changes\n",
  ].join("")

  return (
    <PillButton
      label={label}
      title={title}
      dotColor={run.running ? DOT.warn : phaseDotColor(phase)}
      onClick={run.running ? run.stop : act}
      disabled={phase === "busy" || run.cancelling}
    />
  )
}
