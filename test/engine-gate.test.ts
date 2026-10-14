import { describe, expect, it } from 'vitest'
import type { Events } from '@deepseek-ai/cordis'
import { createEngineGate } from '../src/container/engine-gate.ts'
import type { Provisioner } from '../src/container/provisioner.ts'
import { testConfig } from './helpers.ts'

type PreStep = Events['agent/pre-step']

function fakeProvisioner(answer: { reachable: boolean; error?: string }): Provisioner {
  return { engineReachable: async () => answer } as unknown as Provisioner
}

const payload = {
  agent: { id: 'session-3' },
  messages: [],
  turn: 1,
  step: 1,
  signal: new AbortController().signal,
}

const enter = async () => ({ kind: 'enter', messages: [] })

describe('createEngineGate', () => {
  it('is inert while worktree mode is off, even with the engine down', async () => {
    const gate = createEngineGate(fakeProvisioner({ reachable: false }), testConfig())
    expect(await gate(payload, enter)).toEqual({ kind: 'enter', messages: [] })
  })

  it('lets the step through when the engine answers', async () => {
    const gate = createEngineGate(fakeProvisioner({ reachable: true }), testConfig({ worktree: true }))
    expect(await gate(payload, enter)).toEqual({ kind: 'enter', messages: [] })
  })

  it('fails the turn with the engine instruction when worktree mode is on and the engine is down', async () => {
    const gate = createEngineGate(
      fakeProvisioner({ reachable: false, error: 'Cannot connect to the Docker daemon' }),
      testConfig({ worktree: true }),
    )
    await expect(gate(payload, enter)).rejects.toThrow(
      /Docker engine is not reachable.*Cannot connect to the Docker daemon.*Start Docker Desktop/s,
    )
  })

  it('reads the worktree toggle live, per step', async () => {
    let on = false
    const config = testConfig()
    ;(config.worktree as unknown as { get(): boolean }).get = () => on
    const gate = createEngineGate(fakeProvisioner({ reachable: false }), config)
    expect(await gate(payload, enter)).toEqual({ kind: 'enter', messages: [] })
    on = true
    await expect(gate(payload, enter)).rejects.toThrow(/Docker engine is not reachable/)
  })

  it('syncs the session worktree once per turn, before the step runs', async () => {
    const synced: string[] = []
    const worktrees = {
      syncFor: async (sessionId: string, workspace: string) => {
        synced.push(`${sessionId}@${workspace}`)
        return { state: 'up-to-date' as const }
      },
    }
    const gate = createEngineGate(
      fakeProvisioner({ reachable: true }),
      testConfig({ worktree: true }),
      { worktrees: worktrees as never, workspaceFor: () => 'F:\\Projects\\x' },
    )
    await gate(payload, enter)
    await gate({ ...payload, step: 2 }, enter)
    await gate({ ...payload, turn: 2 }, enter)
    expect(synced).toEqual(['session-3@F:\\Projects\\x', 'session-3@F:\\Projects\\x'])
  })

  it('does not sync when the turn was refused for an unreachable engine', async () => {
    const synced: string[] = []
    const worktrees = { syncFor: async (sessionId: string) => { synced.push(sessionId) } }
    const gate = createEngineGate(
      fakeProvisioner({ reachable: false }),
      testConfig({ worktree: true }),
      { worktrees: worktrees as never, workspaceFor: () => 'F:\\Projects\\x' },
    )
    await expect(gate(payload, enter)).rejects.toThrow(/Docker engine is not reachable/)
    expect(synced).toEqual([])
  })
})
