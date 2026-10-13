/**
 * The session-header review button.
 *
 * Spawns a fresh subagent that reviews the code changes this conversation
 * made in its worktree. The reviewer starts with a clean slate: it carries no
 * reasoning from the main agent — its only inputs are the diff the plugin
 * collected from the worktree and the tools it runs itself in the sandbox.
 *
 * Like the merge button, it renders only when the status route reports a
 * worktree for the chat. Once the review starts, the child session appears in
 * the app's subagent UI; this button reports the child's id in its tooltip.
 *
 * @module dsh-docker-sandbox/client/review-button
 */

import { useCallback, useEffect, useState } from "react"
import { fetchSandboxStatus, requestReview, type ReviewView, type WorktreeView } from "./api.ts"

/** How often the button re-reads the worktree state while mounted. */
const POLL_MS = 15000

export interface ReviewButtonProps {
  /** The conversation this header belongs to (a standard slot prop). */
  sessionId: string
}

type Phase = "idle" | "busy" | "done" | "error"

export function ReviewButton({ sessionId }: ReviewButtonProps) {
  const [worktree, setWorktree] = useState<WorktreeView | undefined>(undefined)
  const [phase, setPhase] = useState<Phase>("idle")
  const [result, setResult] = useState<ReviewView | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const next = await fetchSandboxStatus(sessionId)
        if (!alive) return
        setWorktree(next.worktree)
      } catch {
        // The chip already reports a broken sandbox; this button just stays hidden.
      }
    }
    void load()
    const timer = setInterval(() => void load(), POLL_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [sessionId])

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

  // No worktree (mode off, non-git workspace, or none created yet): nothing
  // isolated to review, so the header shows no button.
  if (worktree === undefined) return null

  const label = phase === "busy"
    ? "reviewing…"
    : phase === "done"
      ? "review started"
      : phase === "error"
        ? "retry review"
        : "review"

  const dotColor = phase === "done"
    ? "var(--dsw-alias-state-success-primary)"
    : phase === "error"
      ? "var(--dsw-alias-state-error-primary)"
      : phase === "busy"
        ? "var(--dsw-alias-state-warn-primary)"
        : "var(--dsw-alias-state-idle-primary)"

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
        {label}
      </span>
    </button>
  )
}
