// A subagent kind holds one slot key per session at a time: a resolver mutates
// the worktree, and a fan-out of review children would swamp the session. The
// slot expires on its own: a child whose result never settles must not lock the
// button for the rest of the session. A slot releases only its own entry, so a
// run that outlived the expiry cannot free whoever replaced it.
const RESOLVER_TTL_MS = 15 * 60_000

export interface ResolverSlot {
  release(): void
}

export interface ResolverGuard {
  tryStart(key: string): ResolverSlot | undefined
}

export function createResolverGuard(now: () => number = Date.now): ResolverGuard {
  const held = new Map<string, ResolverSlot & { expiresAt: number }>()
  return {
    tryStart: (key) => {
      const previous = held.get(key)
      if (previous !== undefined && previous.expiresAt > now()) return undefined
      const slot: ResolverSlot & { expiresAt: number } = {
        expiresAt: now() + RESOLVER_TTL_MS,
        release: () => {
          if (held.get(key) === slot) held.delete(key)
        },
      }
      held.set(key, slot)
      return slot
    },
  }
}
