// augments cordis with DSH host events; shapes mirror call sites in bundle 0.2.0-rc.2, keep in sync when the app updates

declare module "@deepseek-ai/cordis" {
  interface Events {
    // parallel hook: owners of session work (agents, jobs, subagents, schedules, ours) stop with an archived conversation
    "workspace/session-stop"(payload: { sessionId: string }): void

    // broadcast: session torn down (archived, deleted, settled child); its container can leave with it, not wait out the TTL
    "session/disposed"(session: { id: string }): void

    // waterfall: runs before a proposed step; { kind: "reject" } ends the turn silently, a throw ends it with a visible error
    "agent/pre-step"(
      payload: {
        agent: { id: string }
        // the inbox batch claimed for this step
        messages: readonly unknown[]
        turn: number
        step: number
        signal: AbortSignal
      },
      next: () => Promise<{ kind: string; messages?: readonly unknown[] }>,
    ): Promise<{ kind: string; messages?: readonly unknown[] }>
  }
}

export {}
