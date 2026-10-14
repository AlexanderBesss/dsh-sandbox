/**
 * The readable name a conversation gets on the remote.
 *
 * A branch name, a commit subject, and a pull-request title all want a phrase a
 * human wrote or would recognize, and the app already has one: the chat title,
 * which `dsh-session-title` derives from the first prompt (and later from the
 * model). Reading it is a convenience, never a dependency — every lookup is
 * guarded, and a conversation with no title keeps the session-slug naming this
 * plugin had before.
 *
 * @module dsh-docker-sandbox/container/session-title
 */

import type { SandboxContext } from "../context.ts"

/** Reads a conversation's readable name, when the app has one. */
export type SessionTitleReader = (sessionId: string) => string | undefined

/** The title service slice (`dsh-session-title`), as this plugin samples it. */
interface TitleServiceSlice {
  /** Latest folded title for one live session, or undefined before any input. */
  get?(session: unknown): { title?: string } | undefined
}

/** One logged event, as this plugin reads it for the first prompt. */
interface LoggedEvent {
  type?: string
  data?: {
    source?: { kind?: string }
    content?: Array<{ type?: string; text?: string }>
  }
}

/**
 * The first eligible human message in a session log, as plain text.
 *
 * Same eligibility the title service uses (`user/message` from a `user` source
 * with visible text), so the fallback names a branch after the message the app
 * would have titled the chat from.
 */
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

/**
 * Build the reader for one plugin context.
 *
 * Preference order:
 *
 * 1. the app's own title (`sessionTitle.get(session)`) — the phrase the chat
 *    list shows, chosen by the model or typed by the user;
 * 2. the first human message in the session log — the worktree (and so the
 *    branch) is created on the first tool call, when the title service may still
 *    be generating, but the message that started the turn is already logged;
 * 3. nothing, which leaves the caller on the session slug.
 *
 * The `sessionTitle` name is sampled from the live app rather than declared by
 * this package: if the app does not provide that service, path 1 yields nothing
 * and the log decides — the naming degrades, it does not fail.
 *
 * @param ctx - the plugin context (reads `sessions` and `sessionTitle`).
 * @returns a reader that never throws.
 */
export function createSessionTitleReader(ctx: SandboxContext): SessionTitleReader {
  return (sessionId: string): string | undefined => {
    try {
      const session = ctx.sessions?.get?.(sessionId)
      if (session === undefined) return undefined
      let folded: string | undefined
      try {
        // Strict lookup: an isolated or disposed title service answers undefined
        // rather than handing back a value its fiber no longer keeps live.
        const titles = ctx.get("sessionTitle") as TitleServiceSlice | undefined
        const value = titles?.get?.(session)?.title
        if (typeof value === "string" && value.trim() !== "") folded = value.trim()
      } catch {
        folded = undefined // the service threw, or the name is not provided: use the log
      }
      if (folded !== undefined) return folded
      const events = session.snapshotEvents?.()
      return events === undefined ? undefined : firstPromptText(events)
    } catch {
      // Naming is a convenience: a failed lookup must never fail the tool call
      // that is creating the worktree.
      return undefined
    }
  }
}
