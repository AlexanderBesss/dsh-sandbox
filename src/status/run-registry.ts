export type SubagentKind = "review" | "resolve"

export interface SubagentHandle {
  kind: SubagentKind
  childSessionId: string
  controller: AbortController
  startedAt: number
  cancelling: boolean
  cancelledAt?: number
}

export interface SubagentView {
  kind: SubagentKind
  childSessionId: string
  startedAt: number
  cancelling: boolean
}

// A started child is kept here so the header pill can offer to stop it: the
// subagent service only cancels a run through the AbortSignal handed to start,
// so the controller has to outlive the request that started the run. Entries
// leave when the run settles, which an abort also causes.
// A child that ignores the abort and never settles would otherwise pin the pill
// in "stopping…" for the rest of the session, so a cancelled entry stops being
// reported after this much time — the same escape the resolver slot has.
const CANCEL_REPORT_TTL_MS = 60_000

export interface SubagentRunRegistry {
  track(sessionId: string, kind: SubagentKind, controller: AbortController, childSessionId: string): SubagentHandle
  release(sessionId: string, handle: SubagentHandle): void
  running(sessionId: string): SubagentHandle[]
  cancel(sessionId: string, kind: SubagentKind): SubagentHandle[]
  cancelAll(sessionId: string): SubagentHandle[]
  findByChild(childSessionId: string): { sessionId: string; handle: SubagentHandle } | undefined
}

export function createSubagentRunRegistry(now: () => number = Date.now): SubagentRunRegistry {
  const tracked = new Map<string, Set<SubagentHandle>>()
  const reported = (handle: SubagentHandle): boolean =>
    handle.cancelledAt === undefined || now() - handle.cancelledAt <= CANCEL_REPORT_TTL_MS
  const abortMatching = (sessionId: string, matches: (handle: SubagentHandle) => boolean): SubagentHandle[] => {
    const held = tracked.get(sessionId)
    if (held === undefined) return []
    const hit = [...held].filter(matches)
    for (const handle of hit) {
      handle.cancelling = true
      handle.cancelledAt = now()
      handle.controller.abort()
    }
    return hit
  }
  return {
    track: (sessionId, kind, controller, childSessionId) => {
      const handle: SubagentHandle = { kind, childSessionId, controller, startedAt: now(), cancelling: false }
      const held = tracked.get(sessionId) ?? new Set<SubagentHandle>()
      held.add(handle)
      tracked.set(sessionId, held)
      return handle
    },
    release: (sessionId, handle) => {
      const held = tracked.get(sessionId)
      if (held === undefined) return
      held.delete(handle)
      if (held.size === 0) tracked.delete(sessionId)
    },
    running: (sessionId) => [...(tracked.get(sessionId) ?? [])].filter(reported),
    cancel: (sessionId, kind) => abortMatching(sessionId, (handle) => handle.kind === kind),
    cancelAll: (sessionId) => abortMatching(sessionId, () => true),
    findByChild: (childSessionId) => {
      for (const [sessionId, held] of tracked) {
        for (const handle of held) {
          if (handle.childSessionId === childSessionId && reported(handle)) return { sessionId, handle }
        }
      }
      return undefined
    },
  }
}

export function subagentViews(handles: SubagentHandle[]): SubagentView[] {
  return handles.map((handle) => ({
    kind: handle.kind,
    childSessionId: handle.childSessionId,
    startedAt: handle.startedAt,
    cancelling: handle.cancelling,
  }))
}
