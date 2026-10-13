/**
 * The session-header chip.
 *
 * It answers one question in the place the question is asked: *which container
 * is this conversation running in?* The name is the container name the plugin
 * derives from the session id, so it is the same string `docker ps` shows —
 * clicking it copies the name for pasting into a terminal.
 *
 * The chip never hides a broken sandbox: an unreachable engine shows as a
 * warning state with the reason in its tooltip, because a silently missing chip
 * would read as "no sandbox", which is the opposite of the truth.
 *
 * @module dsh-docker-sandbox/client/chip
 */

import { useCallback, useEffect, useState } from "react"
import { fetchSandboxStatus, type SandboxStatusView } from "./api.ts"

/** How often the chip re-reads its status while mounted. */
const POLL_MS = 15000

/** One state row for the tooltip. */
function row(label: string, value: string | undefined): string {
  return value === undefined || value === "" ? "" : `${label}: ${value}\n`
}

export interface ContainerChipProps {
  /** The conversation this header belongs to (a standard slot prop). */
  sessionId: string
}

export function ContainerChip({ sessionId }: ContainerChipProps) {
  const [status, setStatus] = useState<SandboxStatusView | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const next = await fetchSandboxStatus(sessionId)
        if (!alive) return
        setStatus(next)
        setError(next.error)
      } catch (cause) {
        if (!alive) return
        setError((cause as Error).message)
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

  const copy = useCallback(() => {
    if (status === undefined) return
    void navigator.clipboard?.writeText(status.container).then(() => {
      setCopied(true)
    }, () => undefined)
  }, [status])

  const state = status === undefined
    ? error === undefined ? "pending" : "error"
    : status.ready ? "ready" : status.phase === "absent" ? "absent" : "pending"

  const dotColor = state === "ready"
    ? "var(--dsw-alias-state-success-primary)"
    : state === "error"
      ? "var(--dsw-alias-state-error-primary)"
      : state === "absent"
        ? "var(--dsw-alias-state-idle-primary)"
        : "var(--dsw-alias-state-warn-primary)"

  const label = status?.container ?? (error === undefined ? "sandbox…" : "sandbox")

  const title = [
    status === undefined ? "" : `container ${status.container}\n`,
    status === undefined ? "" : `phase ${status.phase} · image ${status.image}\n`,
    status === undefined ? "" : row("workspace", status.workspace),
    status === undefined ? "" : row("mounted at", status.containerWorkspace),
    error === undefined ? "" : `unavailable: ${error}\n`,
    copied ? "copied" : "click to copy the container name",
  ].join("")

  return (
    <button
      type="button"
      onClick={copy}
      title={title}
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
        cursor: "pointer",
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
        {copied ? "copied" : label}
      </span>
    </button>
  )
}
