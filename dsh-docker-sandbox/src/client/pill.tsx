import { useCallback, useEffect, useState } from "react"
import { fetchSandboxStatus, type SandboxStatusView } from "./api.ts"

const POLL_MS = 15000
const COPIED_RESET_MS = 1500

export const DOT = {
  success: "var(--dsw-alias-state-success-primary)",
  error: "var(--dsw-alias-state-error-primary)",
  warn: "var(--dsw-alias-state-warn-primary)",
  idle: "var(--dsw-alias-state-idle-primary)",
} as const

export type PillPhase = "idle" | "busy" | "done" | "error"

export function phaseDotColor(phase: PillPhase): string {
  return phase === "done"
    ? DOT.success
    : phase === "error"
      ? DOT.error
      : phase === "busy"
        ? DOT.warn
        : DOT.idle
}

export function useSandboxStatus(sessionId: string): { status?: SandboxStatusView; error?: string } {
  const [status, setStatus] = useState<SandboxStatusView | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)

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

  return { status, error }
}

export function useCopied(): { copied: boolean; markCopied: () => void } {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), COPIED_RESET_MS)
    return () => clearTimeout(timer)
  }, [copied])
  const markCopied = useCallback(() => setCopied(true), [])
  return { copied, markCopied }
}

export function copyText(text: string, markCopied: () => void): void {
  void navigator.clipboard?.writeText(text).then(markCopied, () => undefined)
}

export interface PillButtonProps {
  label: string
  title: string
  dotColor: string
  onClick: () => void
  disabled?: boolean
}

export function PillButton({ label, title, dotColor, onClick, disabled }: PillButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      disabled={disabled}
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
        cursor: disabled ? "wait" : "pointer",
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
