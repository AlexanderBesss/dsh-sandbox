// A resolver mutates the worktree, so only one may run per session at a time.
// The slot expires on its own: a child whose result never settles must not lock
// the button for the rest of the session. A slot releases only its own entry, so
// a resolver that outlived the expiry cannot free whoever replaced it.
const RESOLVER_TTL_MS = 15 * 60_000

export interface ResolverSlot {
  release(): void
}

export interface ResolverGuard {
  tryStart(sessionId: string): ResolverSlot | undefined
}

export function createResolverGuard(now: () => number = Date.now): ResolverGuard {
  const held = new Map<string, ResolverSlot & { expiresAt: number }>()
  return {
    tryStart: (sessionId) => {
      const previous = held.get(sessionId)
      if (previous !== undefined && previous.expiresAt > now()) return undefined
      const slot: ResolverSlot & { expiresAt: number } = {
        expiresAt: now() + RESOLVER_TTL_MS,
        release: () => {
          if (held.get(sessionId) === slot) held.delete(sessionId)
        },
      }
      held.set(sessionId, slot)
      return slot
    },
  }
}
