import { useCallback, useState } from "react"
import { createMergeRequest, type MergeRequestView, type WorktreeView } from "./api.ts"
import { DOT, PillButton, copyText, phaseDotColor, useCopied, useSandboxStatus, type PillPhase } from "./pill.tsx"

export interface MergeRequestButtonProps {
  sessionId: string
}

export function MergeRequestButton({ sessionId }: MergeRequestButtonProps) {
  const { status } = useSandboxStatus(sessionId)
  const worktree: WorktreeView | undefined = status?.worktree
  const [phase, setPhase] = useState<PillPhase>("idle")
  const [result, setResult] = useState<MergeRequestView | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const { copied, markCopied } = useCopied()

  const act = useCallback(() => {
    const link = result?.prUrl ?? result?.compareUrl
    if (phase === "done") {
      if (link === undefined) return
      copyText(link, markCopied)
      return
    }
    if (phase === "busy") return
    setPhase("busy")
    setError(undefined)
    void createMergeRequest(sessionId).then(
      (next) => {
        setResult(next)
        setPhase("done")
      },
      (cause: unknown) => {
        setError((cause as Error).message)
        setPhase("error")
      },
    )
  }, [phase, result, sessionId, markCopied])

  if (worktree === undefined) return null

  const link = result?.prUrl ?? result?.compareUrl
  const label = phase === "busy"
    ? "merging…"
    : phase === "done"
      ? result?.prUrl !== undefined
        ? "PR opened"
        : result?.pushed
          ? "pushed"
          : "committed"
      : phase === "error"
        ? "retry merge"
        : "merge request"

  const opened = result?.prUrl !== undefined
  const dotColor = phase === "done"
    ? opened || result?.prError === undefined
      ? DOT.success
      : DOT.warn
    : phaseDotColor(phase)

  const title = [
    `branch ${worktree.branch}\n`,
    `worktree ${worktree.path}\n`,
    worktree.dirty ? "uncommitted changes will be committed\n" : "",
    worktree.unpushed ? "unpushed commits on the branch\n" : "",
    worktree.merging ? "mid-merge with main: resolve the conflicts in the chat first\n" : "",
    worktree.behind !== undefined && worktree.behind > 0 ? `${worktree.behind} commit(s) behind main\n` : "",
    result?.prUrl === undefined ? "" : `pull request: ${result.prUrl}\n`,
    result?.prError === undefined ? "" : `no pull request: ${result.prError}\n`,
    result?.renamedFrom === undefined ? "" : `branch renamed from ${result.renamedFrom}\n`,
    result?.nameNote === undefined ? "" : `${result.nameNote}\n`,
    result?.briefError === undefined ? "" : `no AI naming pass: ${result.briefError}\n`,
    result?.compareUrl === undefined ? "" : `open the merge request by hand: ${result.compareUrl}\n`,
    error === undefined ? "" : `failed: ${error}\n`,
    phase === "done" && link !== undefined
      ? copied ? "copied" : "click to copy the link"
      : "commit, push, and open a merge request for this session's changes",
  ].join("")

  return (
    <PillButton
      label={phase === "done" && copied ? "copied" : label}
      title={title}
      dotColor={dotColor}
      onClick={act}
      disabled={phase === "busy"}
    />
  )
}
