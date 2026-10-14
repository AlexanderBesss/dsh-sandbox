import { describe, expect, it } from 'vitest'
import type { SandboxContext, SubagentResult, SubagentRun, DurableUserMessage } from '../src/context.ts'
import { CONFLICT_SETTLEMENT, REVIEW_SETTLEMENT, settleSubagentRun, settlementMessage } from '../src/status.ts'

interface FakeAgent {
  id: string
  status: 'idle' | 'running'
  delivered: DurableUserMessage[]
  followup(message: DurableUserMessage): void
  steer(message: DurableUserMessage): void
}

function fakeAgent(status: FakeAgent['status']): FakeAgent {
  const agent: FakeAgent = {
    id: 'parent-1',
    status,
    delivered: [],
    followup(message) { agent.delivered.push(message) },
    steer(message) { agent.delivered.push(message) },
  }
  return agent
}

function ctxFor(agent: FakeAgent | undefined): SandboxContext {
  return { agents: { get: () => agent } } as unknown as SandboxContext
}

function runFor(
  result: Promise<SubagentResult>,
  dispose?: () => Promise<void>,
): { run: SubagentRun; disposed: () => boolean } {
  let disposed = false
  const run: SubagentRun = {
    localAgent: { session: { id: 'child-1' } },
    result,
    dispose: dispose ?? (async () => { disposed = true }),
  }
  return { run, disposed: () => disposed }
}

describe('settleSubagentRun', () => {
  it('hands the child verdict to an idle parent as a queued followup', async () => {
    const parent = fakeAgent('idle')
    const { run, disposed } = runFor(Promise.resolve({
      stopReason: 'completed',
      output: [{ type: 'text', text: 'VERDICT: approve, ship it.' }],
    }))
    await settleSubagentRun(ctxFor(parent), run, 'parent-1', 'child-1', REVIEW_SETTLEMENT)
    expect(disposed()).toBe(true)
    expect(parent.delivered).toHaveLength(1)
    const text = parent.delivered[0]!.content.map((block) => block.text ?? '').join('\n')
    expect(text).toContain('finished')
    expect(text).toContain('VERDICT: approve, ship it.')
    expect(parent.delivered[0]!.source.senderSessionId).toBe('child-1')
  })

  it('steers a parent that is mid-turn instead of queueing behind its turn', async () => {
    const parent = fakeAgent('running')
    const { run } = runFor(Promise.resolve({ stopReason: 'completed', output: [] }))
    await settleSubagentRun(ctxFor(parent), run, 'parent-1', 'child-1', REVIEW_SETTLEMENT)
    expect(parent.delivered).toHaveLength(1)
    expect(parent.delivered[0]!.content.map((b) => b.text).join(' ')).toContain('left no closing message')
  })

  it('still disposes and reports when the child failed', async () => {
    const parent = fakeAgent('idle')
    const { run, disposed } = runFor(Promise.reject(new Error('child exploded')))
    await settleSubagentRun(ctxFor(parent), run, 'parent-1', 'child-1', REVIEW_SETTLEMENT)
    expect(disposed()).toBe(true)
    const text = parent.delivered[0]!.content.map((block) => block.text ?? '').join('\n')
    expect(text).toContain('ended (unknown)')
  })

  it('survives a disposal failure without losing the verdict', async () => {
    const parent = fakeAgent('idle')
    const { run } = runFor(
      Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'fine' }] }),
      async () => { throw new Error('dispose failed') },
    )
    await settleSubagentRun(ctxFor(parent), run, 'parent-1', 'child-1', REVIEW_SETTLEMENT)
    expect(parent.delivered).toHaveLength(1)
  })

  it('is a no-op when the parent closed while the review ran', async () => {
    const { run, disposed } = runFor(Promise.resolve({ stopReason: 'completed', output: [] }))
    await settleSubagentRun(ctxFor(undefined), run, 'gone', 'child-1', REVIEW_SETTLEMENT)
    expect(disposed()).toBe(true)
  })
})

describe('settlementMessage', () => {
  it('names the stop reason in the summary line', () => {
    expect(settlementMessage('c1', { stopReason: 'aborted', output: [] }, REVIEW_SETTLEMENT).content[0]!.text ?? '')
      .toContain('stopped before it finished')
  })

  it('speaks of a resolver, not a reviewer, when the child resolved conflicts', () => {
    const message = settlementMessage(
      'c1',
      { stopReason: 'completed', output: [{ type: 'text', text: 'MERGE COMMITTED abc1234' }] },
      CONFLICT_SETTLEMENT,
    )
    const text = message.content.map((block) => block.text ?? '').join('\n')
    expect(text).toContain('conflict resolver')
    expect(text).toContain('How it resolved the conflicts:')
    expect(text).toContain('MERGE COMMITTED abc1234')
    expect(text).not.toContain('review verdict')
  })
})
