import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { createTreeReinstall, createWarmInstall, installCommandFor } from '../src/container/warm-install.ts'
import type { WorktreeEntry } from '../src/container/worktrees.ts'
import { testConfig, fakeTransport } from './helpers.ts'

const root = mkdtempSync(join(tmpdir(), 'dsh-warm-'))
const worktreePath = join(root, 'wt')
mkdirSync(worktreePath)
writeFileSync(join(worktreePath, 'package-lock.json'), '{"lockfileVersion":3}')

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

const entry = (path: string): WorktreeEntry => ({
  sessionId: 'session-3',
  mainWorkspace: 'F:\\Projects\\dsh-sandbox',
  repoRoot: 'F:\\Projects\\dsh-sandbox',
  worktreePath: path,
  branch: 'dsh-sbx/session-3',
  createdAt: 0,
  hostGitDir: 'F:/Projects/dsh-sandbox/.git/worktrees/wt',
  gitConfig: {},
})

interface Harness {
  runs: { argv: string[] }[]
  leases: { began: number; released: number }
}

function harness(options: {
  entry?: WorktreeEntry | undefined
  config?: ReturnType<typeof testConfig>
  execFails?: boolean
}) {
  const { transport } = fakeTransport()
  const state: Harness = { runs: [], leases: { began: 0, released: 0 } }
  const execInContainer = transport.execInContainer.bind(transport)
  vi.spyOn(transport, 'execInContainer').mockImplementation(async (target, argv, opts) => {
    state.runs.push({ argv })
    if (options.execFails === true) throw new Error('exec blew up')
    return execInContainer(target, argv, opts)
  })
  const provisioner = {
    beginWork: (sessionId: string) => {
      state.leases.began += 1
      void sessionId
      return () => {
        state.leases.released += 1
      }
    },
  } as never
  const worktrees = {
    lookup: () => options.entry,
  } as never
  const deps = {
    transport,
    provisioner,
    worktrees,
    config: options.config ?? testConfig({ worktree: true }),
  } as never
  return { warm: createWarmInstall(deps), reinstall: createTreeReinstall(deps), state }
}

const target = { sessionId: 'session-3', container: 'dsh-sbx-session-3', workspace: worktreePath, shared: false }

describe('installCommandFor', () => {
  it('pins a package-lock.json workspace to npm ci without lifecycle scripts', () => {
    expect(installCommandFor(worktreePath)).toBe('npm ci --prefer-offline --ignore-scripts')
  })

  it('keeps lifecycle scripts only when the operator opts in', () => {
    expect(installCommandFor(worktreePath, true)).toBe('npm ci --prefer-offline')
  })

  it('names no command for a workspace without a lockfile', () => {
    const bare = join(root, 'bare')
    mkdirSync(bare)
    expect(installCommandFor(bare)).toBeUndefined()
  })
})

describe('createWarmInstall', () => {
  it('runs npm ci in the container and holds a lease while it runs', async () => {
    const { warm, state } = harness({ entry: entry(worktreePath) })
    warm(target)
    await vi.waitFor(() => expect(state.leases.released).toBe(1))
    expect(state.runs[0]?.argv).toEqual(['/bin/sh', '-lc', 'npm ci --prefer-offline --ignore-scripts'])
    expect(state.leases.began).toBe(1)
  })

  it('keeps lifecycle scripts only when the operator opts in through config', async () => {
    const { warm, state } = harness({
      entry: entry(worktreePath),
      config: testConfig({ worktree: true, worktreeInstallScripts: true }),
    })
    warm(target)
    await vi.waitFor(() => expect(state.leases.released).toBe(1))
    expect(state.runs[0]?.argv).toEqual(['/bin/sh', '-lc', 'npm ci --prefer-offline'])
  })

  it('leaves a worktree that already has node_modules alone', async () => {
    const installed = join(root, 'installed')
    mkdirSync(join(installed, 'node_modules'), { recursive: true })
    const { warm, state } = harness({ entry: entry(installed) })
    warm({ ...target, sessionId: 'session-installed', workspace: installed })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(state.runs).toHaveLength(0)
    expect(state.leases.began).toBe(0)
  })

  it('skips a session that shares the checkout (no worktree entry)', async () => {
    const { warm, state } = harness({ entry: undefined })
    warm(target)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(state.runs).toHaveLength(0)
  })

  it('is inert while worktreeInstall is off', async () => {
    const { warm, state } = harness({ entry: entry(worktreePath), config: testConfig({ worktree: true, worktreeInstall: false }) })
    warm(target)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(state.runs).toHaveLength(0)
  })

  it('warms each session once per process', async () => {
    const { warm, state } = harness({ entry: entry(worktreePath) })
    warm(target)
    warm(target)
    await vi.waitFor(() => expect(state.leases.released).toBe(1))
    expect(state.runs).toHaveLength(1)
  })

  it('releases the lease even when the install throws', async () => {
    const { warm, state } = harness({ entry: entry(worktreePath), execFails: true })
    warm(target)
    await vi.waitFor(() => expect(state.leases.released).toBe(1))
    expect(state.leases.began).toBe(1)
  })
})

describe('createTreeReinstall', () => {
  it('reinstalls a worktree that has node_modules, without lifecycle scripts', async () => {
    const reinstalled = join(root, 'reinstalled')
    mkdirSync(join(reinstalled, 'node_modules'), { recursive: true })
    writeFileSync(join(reinstalled, 'package-lock.json'), '{"lockfileVersion":3}')
    const { reinstall, state } = harness({ entry: entry(reinstalled) })
    reinstall(entry(reinstalled))
    await vi.waitFor(() => expect(state.runs).toHaveLength(1))
    expect(state.runs[0]?.argv).toEqual(['/bin/sh', '-lc', 'npm ci --prefer-offline --ignore-scripts'])
  })

  it('honours the scripts opt-in through config', async () => {
    const opted = join(root, 'opted')
    mkdirSync(join(opted, 'node_modules'), { recursive: true })
    writeFileSync(join(opted, 'package-lock.json'), '{"lockfileVersion":3}')
    const { reinstall, state } = harness({
      entry: entry(opted),
      config: testConfig({ worktree: true, worktreeInstallScripts: true }),
    })
    reinstall(entry(opted))
    await vi.waitFor(() => expect(state.runs).toHaveLength(1))
    expect(state.runs[0]?.argv).toEqual(['/bin/sh', '-lc', 'npm ci --prefer-offline'])
  })

  it('skips a worktree with nothing installed to redo', () => {
    const { reinstall, state } = harness({ entry: entry(worktreePath) })
    reinstall(entry(worktreePath))
    expect(state.runs).toHaveLength(0)
  })
})
