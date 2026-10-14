import { resolveConflicts, type WorktreeView } from "./api.ts"
import {
  DOT,
  PillButton,
  phaseDotColor,
  uniqueChildSessionIds,
  usePillAction,
  useSandboxStatus,
  useSubagentRun,
} from "./pill.tsx"

const MAX_LISTED_FILES = 8

export interface ResolveConflictsButtonProps {
  sessionId: string
}

export function ResolveConflictsButton({ sessionId }: ResolveConflictsButtonProps) {
  const { status } = useSandboxStatus(sessionId)
  const worktree: WorktreeView | undefined = status?.worktree
  const action = usePillAction(resolveConflicts, sessionId)
  const resolver = useSubagentRun(status, sessionId, "resolve")

  if (worktree === undefined || worktree.merging !== true) return null

  const conflicts = worktree.conflicts ?? []
  const childIds = uniqueChildSessionIds(action.result?.childSessionId, resolver.childSessionIds)
  const failure = resolver.stopError ?? action.error

  const label = action.phase === "busy"
    ? "resolving…"
    : resolver.running
      ? resolver.cancelling
        ? "stopping…"
        : "stop resolver"
      : action.phase === "done"
        ? "resolver started"
        : action.phase === "error"
          ? "retry resolver"
          : "resolve conflicts"

  const title = [
    `branch ${worktree.branch}\n`,
    conflicts.length === 0
      ? "the merge is still open, and no file is marked conflicted anymore\n"
      : `${conflicts.length} conflicted file(s):\n`,
    ...conflicts.slice(0, MAX_LISTED_FILES).map((file) => `  ${file}\n`),
    conflicts.length > MAX_LISTED_FILES ? `  … and ${conflicts.length - MAX_LISTED_FILES} more\n` : "",
    ...childIds.map((id) => `resolver session: ${id}\n`),
    action.result === undefined ? "" : `it was handed ${action.result.conflicts} conflicted file(s)\n`,
    failure === undefined ? "" : `failed: ${failure}\n`,
    resolver.running
      ? resolver.cancelling
        ? "stopping the resolver; the worktree stays mid-merge with whatever it resolved so far\n"
        : "click to stop the resolver — the worktree stays mid-merge with whatever it resolved so far, and you can resolve the rest yourself or start another\n"
      : action.phase === "done"
        ? "the resolver runs in its own child session, and the worktree stays mid-merge until it commits\n"
        : "hand the mid-merge worktree to a fresh resolver: it reads both sides, resolves the markers, and commits the merge\n",
  ].join("")

  return (
    <PillButton
      label={label}
      title={title}
      dotColor={resolver.running || action.phase === "done" ? DOT.warn : phaseDotColor(action.phase)}
      onClick={resolver.running ? resolver.stop : action.run}
      disabled={action.phase === "busy" || resolver.cancelling}
    />
  )
}
