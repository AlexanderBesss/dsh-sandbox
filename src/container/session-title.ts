import type { SandboxContext } from "../context.ts"

export type SessionTitleReader = (sessionId: string) => string | undefined

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

function serviceTitle(ctx: SandboxContext, session: unknown): string | undefined {
  try {
    const titles = ctx.get("sessionTitle") as TitleServiceSlice | undefined
    const value = titles?.get?.(session)?.title
    return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined
  } catch {
    return undefined
  }
}

export function createSessionTitleReader(ctx: SandboxContext): SessionTitleReader {
  return (sessionId: string): string | undefined => {
    try {
      const session = ctx.sessions?.get?.(sessionId)
      if (session === undefined) return undefined
      return serviceTitle(ctx, session) ?? firstPromptText(session.snapshotEvents?.() ?? [])
    } catch {
      return undefined
    }
  }
}
