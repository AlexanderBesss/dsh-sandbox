import { useCallback, useState } from "react"
import { resolveConflicts, type ResolveView, type WorktreeView } from "./api.ts"
import {
  DOT,
  PillButton,
  phaseDotColor,
  useSandboxStatus,
  useSubagentRun,
  type PillPhase,
} from "./pill.tsx"

const MAX_LISTED_FILES = 8

export interface ResolveConflictsButtonProps {
  sessionId: string
}

export function ResolveConflictsButton({ sessionId }: ResolveConflictsButtonProps) {
  const { status } = useSandboxStatus(sessionId)
  const worktree: WorktreeView | undefined = status?.worktree
  const [phase, setPhase] = useState<PillPhase>("idle")
  const [result, setResult] = useState<ResolveView | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const run = useSubagentRun(status, sessionId, "resolve")

  const act = useCallback(() => {
    if (phase === "busy") return
    setPhase("busy")
    setError(undefined)
    void resolveConflicts(sessionId).then(
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

  if (worktree === undefined || worktree.merging !== true) return null

  const conflicts = worktree.conflicts ?? []
  const childIds = [...new Set(
    [result?.childSessionId, ...run.childSessionIds].filter((id): id is string => id !== undefined && id !== ""),
  )]
  const failure = run.stopError ?? error

  const label = phase === "busy"
    ? "resolving…"
    : run.running
      ? run.cancelling
        ? "stopping…"
        : "stop resolver"
      : phase === "done"
        ? "resolver started"
        : phase === "error"
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
    result === undefined ? "" : `it was handed ${result.conflicts} conflicted file(s)\n`,
    failure === undefined ? "" : `failed: ${failure}\n`,
    run.running
      ? run.cancelling
        ? "stopping the resolver; the worktree stays mid-merge with whatever it resolved so far\n"
        : "click to stop the resolver — the worktree stays mid-merge with whatever it resolved so far, and you can resolve the rest yourself or start another\n"
      : phase === "done"
        ? "the resolver runs in its own child session, and the worktree stays mid-merge until it commits\n"
        : "hand the mid-merge worktree to a fresh resolver: it reads both sides, resolves the markers, and commits the merge\n",
  ].join("")

  return (
    <PillButton
      label={label}
      title={title}
      dotColor={run.running || phase === "done" ? DOT.warn : phaseDotColor(phase)}
      onClick={run.running ? run.stop : act}
      disabled={phase === "busy" || run.cancelling}
    />
  )
}
