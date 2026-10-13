import { describe, expect, it } from 'vitest'
import { CONTAINER_PREFIX, OWNERSHIP_LABEL, SandboxSessionError, containerNameFor, resolveTarget, targetForSession } from '../src/container/session.ts'
import type { WorktreeEntry, WorktreeManager } from '../src/container/worktrees.ts'
import type { SandboxContext } from '../src/context.ts'
import { testConfig } from './helpers.ts'

const DOCKER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/

describe('containerNameFor', () => {
  it('names the container after the conversation', () => {
    expect(containerNameFor('session-3')).toBe(`${CONTAINER_PREFIX}session-3`)
  })

  it('sanitizes characters a container name cannot carry', () => {
    // A rewritten slug carries the id's digest, so it is slug + digest, not
    // the bare slug.
    const name = containerNameFor('agent/worker 7')
    expect(name.startsWith(`${CONTAINER_PREFIX}agent-worker-7-`)).toBe(true)
    expect(name).toMatch(DOCKER_NAME)
  })

  it('separates two ids that sanitize to the same slug', () => {
    // `Session_42` and `session-42` strip to one slug; without a digest one
    // chat would run inside the other's box.
    const upper = containerNameFor('Session_42')
    const plain = containerNameFor('session-42')
    expect(upper).not.toBe(plain)
    expect(plain).toBe(`${CONTAINER_PREFIX}session-42`) // lossless ids keep the bare slug
    expect(upper.startsWith(`${CONTAINER_PREFIX}session-42-`)).toBe(true)
  })

  it('falls back to a named container for an empty id', () => {
    expect(containerNameFor('')).toBe(`${CONTAINER_PREFIX}unnamed`)
  })

  it('stays a valid docker container name whatever comes in', () => {
    for (const id of ['', '---', 'a'.repeat(200), 'session-3', 'Ünïcødé session']) {
      const name = containerNameFor(id)
      expect(name.length).toBeLessThanOrEqual(63)
      expect(name).toMatch(DOCKER_NAME)
    }
  })

  it('is stable, so the name a user reads is the name docker ps shows', () => {
    expect(containerNameFor('session-3')).toBe(containerNameFor('session-3'))
  })

  it('separates two long ids that share a prefix', () => {
    // Truncating the slug alone would name one container for both chats, and
    // one conversation would run inside the other's box.
    const base = 'x'.repeat(60)
    const first = containerNameFor(`${base}-one`)
    const second = containerNameFor(`${base}-two`)
    expect(first).not.toBe(second)
    expect(first).toMatch(DOCKER_NAME)
    expect(second).toMatch(DOCKER_NAME)
    // Still readable: the prefix of the conversation id survives.
    expect(first.startsWith(`${CONTAINER_PREFIX}${base.slice(0, 38)}`)).toBe(true)
  })
})

describe('resolveTarget', () => {
  const config = testConfig()

  function contextWith(agent: unknown, cwdFromStore?: string): SandboxContext {
    return {
      agents: { currentInitiator: () => agent },
      sessions: { get: () => (cwdFromStore === undefined ? undefined : { id: 'session-3', header: { cwd: cwdFromStore } }) },
    } as unknown as SandboxContext
  }

  it('routes a chat call to that chat’s container and workspace', () => {
    const target = resolveTarget(
      contextWith({ id: 'session-3', session: { id: 'session-3', header: { cwd: 'F:\\Projects\\other' } } }),
      config,
    )
    expect(target).toEqual({
      sessionId: 'session-3',
      container: `${CONTAINER_PREFIX}session-3`,
      workspace: 'F:\\Projects\\other',
      shared: false,
    })
  })

  it('falls back to the session store for the workspace', () => {
    const target = resolveTarget(contextWith({ id: 'session-3' }, 'F:\\Projects\\stored'), config)
    expect(target.workspace).toBe('F:\\Projects\\stored')
  })

  it('falls back to the configured workspace when the store knows nothing', () => {
    expect(resolveTarget(contextWith({ id: 'session-3' }), config).workspace).toBe(config.workspaceRoot)
  })

  it('refuses a call that cannot name its chat', () => {
    expect(() => resolveTarget(contextWith(undefined), config)).toThrowError(SandboxSessionError)
    expect(() => resolveTarget(contextWith(undefined), config)).toThrow(/not running inside a conversation/)
  })

  it('routes agentless calls to one shared container when configured to', () => {
    const target = resolveTarget(contextWith(undefined), testConfig({ allowAgentless: true }))
    expect(target.shared).toBe(true)
    expect(target.container).toBe(`${CONTAINER_PREFIX}default`)
    expect(target.workspace).toBe(config.workspaceRoot)
  })
})

describe('targetForSession', () => {
  it('names a conversation with no initiating agent, reading its workspace from the store', () => {
    // The terminal panel spawns from the UI, where no agent chain is running;
    // the request already names the conversation, so that is what routes it.
    const ctx = {
      agents: { currentInitiator: () => undefined },
      sessions: { get: (id: string) => ({ id, header: { cwd: 'F:\\Projects\\stored' } }) },
    } as unknown as SandboxContext
    expect(targetForSession(ctx, testConfig(), 'session-3')).toEqual({
      sessionId: 'session-3',
      container: `${CONTAINER_PREFIX}session-3`,
      workspace: 'F:\\Projects\\stored',
      shared: false,
    })
  })

  it('moves a session onto its worktree when the manager gives it one', () => {
    // Worktree mode: the seams mount and read/write the worktree, and the
    // checkout it was carved from rides along for the UI and the merge flow.
    const ctx = {
      agents: { currentInitiator: () => undefined },
      sessions: { get: (id: string) => ({ id, header: { cwd: 'F:\\Projects\\stored' } }) },
    } as unknown as SandboxContext
    const entry: WorktreeEntry = {
      sessionId: 'session-3',
      mainWorkspace: 'F:\\Projects\\stored',
      repoRoot: 'F:\\Projects\\stored',
      worktreePath: 'F:\\Projects\\stored.worktrees\\session-3',
      branch: 'dsh-sbx/session-3',
      createdAt: 0,
      hostGitDir: 'F:/Projects/stored/.git/worktrees/session-3',
      gitConfig: {},
    }
    const worktrees = { ensure: () => entry } as unknown as WorktreeManager
    expect(targetForSession(ctx, testConfig({ worktree: true }), 'session-3', undefined, worktrees)).toEqual({
      sessionId: 'session-3',
      container: `${CONTAINER_PREFIX}session-3`,
      workspace: 'F:\\Projects\\stored.worktrees\\session-3',
      shared: false,
      mainWorkspace: 'F:\\Projects\\stored',
    })
  })

  it('keeps the shared workspace when the manager declines one', () => {
    // Non-git workspace, or a sticky creation failure: the session behaves
    // exactly as it did before worktree mode existed.
    const ctx = {
      agents: { currentInitiator: () => undefined },
      sessions: { get: (id: string) => ({ id, header: { cwd: 'F:\\Projects\\stored' } }) },
    } as unknown as SandboxContext
    const worktrees = { ensure: () => undefined } as unknown as WorktreeManager
    const target = targetForSession(ctx, testConfig({ worktree: true }), 'session-3', undefined, worktrees)
    expect(target.workspace).toBe('F:\\Projects\\stored')
    expect(target.mainWorkspace).toBeUndefined()
  })
})

describe('OWNERSHIP_LABEL', () => {
  it('selects exactly this plugin’s containers', () => {
    expect(OWNERSHIP_LABEL).toBe('dsh.sandbox=1')
  })
})
