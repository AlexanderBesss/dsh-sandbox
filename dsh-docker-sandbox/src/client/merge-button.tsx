
import { useCallback, useEffect, useState } from "react"
import { createMergeRequest, fetchSandboxStatus, type MergeRequestView, type WorktreeView } from "./api.ts"

const POLL_MS = 15000

export interface MergeRequestButtonProps {
  sessionId: string
}

type Phase = "idle" | "busy" | "done" | "error"

export function MergeRequestButton({ sessionId }: MergeRequestButtonProps) {
  const [worktree, setWorktree] = useState<WorktreeView | undefined>(undefined)
  const [phase, setPhase] = useState<Phase>("idle")
  const [result, setResult] = useState<MergeRequestView | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const next = await fetchSandboxStatus(sessionId)
        if (!alive) return
        setWorktree(next.worktree)
      } catch {
      }
    }
    void load()
    const timer = setInterval(() => void load(), POLL_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [sessionId])

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])

  const act = useCallback(() => {
    const link = result?.prUrl ?? result?.compareUrl
    if (phase === "done") {
      if (link === undefined) return
      void navigator.clipboard?.writeText(link).then(() => setCopied(true), () => undefined)
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
  }, [phase, result, sessionId])

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
      ? "var(--dsw-alias-state-success-primary)"
      : "var(--dsw-alias-state-warn-primary)"
    : phase === "error"
      ? "var(--dsw-alias-state-error-primary)"
      : phase === "busy"
        ? "var(--dsw-alias-state-warn-primary)"
        : "var(--dsw-alias-state-idle-primary)"

  const title = [
    `branch ${worktree.branch}\n`,
    `worktree ${worktree.path}\n`,
    worktree.dirty ? "uncommitted changes will be committed\n" : "",
    worktree.unpushed ? "unpushed commits on the branch\n" : "",
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
    <button
      type="button"
      onClick={act}
      title={title}
      disabled={phase === "busy"}
      style={{
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
        cursor: phase === "busy" ? "wait" : "pointer",
      }}
    >
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
      <span style={{ maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {phase === "done" && copied ? "copied" : label}
      </span>
    </button>
  )
}
