import { requestReview, type WorktreeView } from "./api.ts"
import {
  DOT,
  PillButton,
  phaseDotColor,
  uniqueChildSessionIds,
  usePillAction,
  useSandboxStatus,
  useSubagentRun,
} from "./pill.tsx"

export interface ReviewButtonProps {
  sessionId: string
}

export function ReviewButton({ sessionId }: ReviewButtonProps) {
  const { status } = useSandboxStatus(sessionId)
  const worktree: WorktreeView | undefined = status?.worktree
  const action = usePillAction(requestReview, sessionId)
  const reviewer = useSubagentRun(status, sessionId, "review")

  if (worktree === undefined) return null

  const childIds = uniqueChildSessionIds(action.result?.childSessionId, reviewer.childSessionIds)
  const failure = reviewer.stopError ?? action.error

  const label = action.phase === "busy"
    ? "reviewing…"
    : reviewer.running
      ? reviewer.cancelling
        ? "stopping…"
        : "stop review"
      : action.phase === "done"
        ? "review started"
        : action.phase === "error"
          ? "retry review"
          : "review"

  const title = [
    `branch ${worktree.branch}\n`,
    worktree.dirty ? "uncommitted changes will be reviewed\n" : "",
    worktree.unpushed ? "unpushed commits will be reviewed\n" : "",
    ...childIds.map((id) => `review session: ${id}\n`),
    failure === undefined ? "" : `failed: ${failure}\n`,
    reviewer.running
      ? reviewer.cancelling
        ? "stopping the reviewer; the chat is told when it stops\n"
        : "click to stop the reviewer — it reports that it was stopped, and nothing it already read is undone\n"
      : action.phase === "done"
        ? "the reviewer runs in its own child session\n"
        : "spawn a fresh reviewer with no memory of this chat, reviewing only this session's changes\n",
  ].join("")

  return (
    <PillButton
      label={label}
      title={title}
      dotColor={reviewer.running ? DOT.warn : phaseDotColor(action.phase)}
      onClick={reviewer.running ? reviewer.stop : action.run}
      disabled={action.phase === "busy" || reviewer.cancelling}
    />
  )
}
