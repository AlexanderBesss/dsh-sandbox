
declare module "@deepseek-ai/cordis" {
  interface Events {
    "workspace/session-stop"(payload: { sessionId: string }): void

    "session/disposed"(session: { id: string }): void

    "agent/pre-step"(
      payload: {
        agent: { id: string }
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
