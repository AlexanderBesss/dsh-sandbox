// chat titles come from the app's dsh-session-title service; reading one is a convenience, never a dependency
import type { SandboxContext } from "../context.ts"

export type SessionTitleReader = (sessionId: string) => string | undefined

// sampled from the live app's title service, not declared by this package
interface TitleServiceSlice {
  get?(session: unknown): { title?: string } | undefined
}

interface LoggedEvent {
  type?: string
  data?: {
    source?: { kind?: string }
    content?: Array<{ type?: string; text?: string }>
  }
}

// eligibility must match the title service's (user/message from a user source with visible text) so fallbacks agree
function firstPromptText(events: unknown[]): string | undefined {
  for (const item of events) {
    const event = item as LoggedEvent
    if (event?.type !== "user/message" || event.data?.source?.kind !== "user") continue
    const parts: string[] = []
    for (const block of event.data.content ?? []) {
      if (block?.type === "text" && typeof block.text === "string") parts.push(block.text)
    }
    const text = parts.join("\n").trim()
    if (text !== "") return text
  }
  return undefined
}

// the worktree is created on the first tool call, when the title may still be generating; fall back to the first message
export function createSessionTitleReader(ctx: SandboxContext): SessionTitleReader {
  return (sessionId: string): string | undefined => {
    try {
      const session = ctx.sessions?.get?.(sessionId)
      if (session === undefined) return undefined
      let folded: string | undefined
      try {
        // strict lookup: an isolated or disposed service answers undefined rather than a value its fiber no longer keeps live
        const titles = ctx.get("sessionTitle") as TitleServiceSlice | undefined
        const value = titles?.get?.(session)?.title
        if (typeof value === "string" && value.trim() !== "") folded = value.trim()
      } catch {
        folded = undefined
      }
      if (folded !== undefined) return folded
      const events = session.snapshotEvents?.()
      return events === undefined ? undefined : firstPromptText(events)
    } catch {
      // naming is a convenience: a failed lookup must never fail the tool call that is creating the worktree
      return undefined
    }
  }
}
