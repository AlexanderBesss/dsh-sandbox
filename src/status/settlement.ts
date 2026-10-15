import { randomUUID } from "node:crypto"
import type {
  DurableUserMessage,
  SandboxContext,
  SubagentResult,
  SubagentRun,
} from "../context.ts"

export interface SettlementKind {
  subject: string
  verdict: string
}

export const REVIEW_SETTLEMENT: SettlementKind = {
  subject: "The code review of this session's worktree",
  verdict: "Its review verdict:",
}

export const CONFLICT_SETTLEMENT: SettlementKind = {
  subject: "The conflict resolver for this session's worktree",
  verdict: "How it resolved the conflicts:",
}

function settlementSummary(stopReason: string | undefined, kind: SettlementKind): string {
  switch (stopReason) {
    case "completed": return `${kind.subject} finished.`
    case "aborted": return `${kind.subject} was stopped before it finished.`
    case "max-tokens": return `${kind.subject} ran out of room before it finished.`
    case "refusal": return `${kind.subject} declined the task.`
    case "error": return `${kind.subject} failed before it finished.`
    default: return `${kind.subject} ended (${String(stopReason ?? "unknown")}) without reporting.`
  }
}

export function settlementMessage(
  childId: string,
  result: SubagentResult | undefined,
  kind: SettlementKind,
): DurableUserMessage {
  const summary = settlementSummary(result?.stopReason, kind)
  const closing = (result?.output ?? []).filter(
    (block): block is { type: string; text: string } => block.type === "text" && typeof block.text === "string" && block.text !== "",
  )
  return {
    role: "user",
    id: randomUUID(),
    source: { kind: "subagent-settled", form: "notice", summary, senderSessionId: childId },
    content: [
      { type: "text", text: summary },
      ...(closing.length === 0
        ? [{ type: "text", text: "It left no closing message." }]
        : [{ type: "text", text: kind.verdict }, ...closing.map((block) => ({ type: "text", text: block.text }))]),
    ],
  }
}

export async function settleSubagentRun(
  ctx: SandboxContext,
  run: SubagentRun,
  sessionId: string,
  childId: string,
  kind: SettlementKind,
): Promise<void> {
  let result: SubagentResult | undefined
  try {
    result = await run.result
  } catch {
    result = undefined
  }
  try {
    await run.dispose?.()
  } catch {
  }
  try {
    const parent = ctx.agents?.get?.(sessionId)
    if (parent === undefined) return
    const message = settlementMessage(childId, result, kind)
    if (parent.status === "running" && parent.steer !== undefined) parent.steer(message)
    else parent.followup?.(message)
  } catch {
  }
}
