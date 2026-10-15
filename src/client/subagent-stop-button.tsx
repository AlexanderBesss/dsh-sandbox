import { useCallback, useState } from "react"
import { cancelSubagent } from "./api.ts"
import { DOT, PillButton, errorMessage, useSandboxStatus } from "./pill.tsx"

const STOP_LABEL = { review: "stop review", resolve: "stop resolver" } as const

export interface SubagentStopButtonProps {
  sessionId: string
}

// The child's own record view has no worktree, so the parent's pills render
// nothing there; this one resolves the viewed session back to the run that
// started it and stops that run through the parent's registry.
export function SubagentStopButton({ sessionId }: SubagentStopButtonProps) {
  const { status } = useSandboxStatus(sessionId)
  const child = status?.subagentChild
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  const stop = useCallback(() => {
    if (child === undefined || stopping) return
    setStopping(true)
    setError(undefined)
    void cancelSubagent(child.parentSessionId, child.kind).then(
      () => undefined,
      (cause: unknown) => {
        setStopping(false)
        setError(errorMessage(cause))
      },
    )
  }, [child, stopping])

  if (child === undefined) return null

  const cancelling = stopping || child.cancelling
  return (
    <PillButton
      label={cancelling ? "stopping…" : STOP_LABEL[child.kind]}
      title={[
        `this session is the ${child.kind} child of ${child.parentSessionId}\n`,
        cancelling
          ? "stopping the child; the parent chat is told when it stops\n"
          : "click to stop this subagent — it reports that it was stopped, and nothing it already read is undone\n",
        error === undefined ? "" : `failed: ${error}\n`,
      ].join("")}
      dotColor={DOT.warn}
      onClick={stop}
      disabled={cancelling}
    />
  )
}
