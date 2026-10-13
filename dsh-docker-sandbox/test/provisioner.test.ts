import { describe, expect, it } from 'vitest'
import { Provisioner, type ProvisionerHooks } from '../src/container/provisioner.ts'
import { PathMapper } from '../src/container/paths.ts'
import { containerNameFor } from '../src/container/session.ts'
import { testConfig, fakeTransport, type FakeEngine } from './helpers.ts'

const WINDOWS = 'F:\\Projects\\dsh-sandbox'

function makeProvisioner(engine: FakeEngine = {}, overrides = {}, hooks: ProvisionerHooks = {}) {
  const config = testConfig(overrides)
  const { transport, calls } = fakeTransport(engine)
  const provisioner = new Provisioner(transport, config, new PathMapper('workspace', config.containerWorkspace), undefined, hooks)
  const target = {
    sessionId: 'session-3',
    container: containerNameFor('session-3'),
    workspace: WINDOWS,
    shared: false,
  }
  return { provisioner, calls, target, config }
}

describe('Provisioner.runArgs', () => {
  it('describes a labeled container bound to one conversation', () => {
    const { provisioner, target } = makeProvisioner()
    const args = provisioner.runArgs(target)

    expect(args.slice(0, 2)).toEqual(['run', '-d'])
    expect(args).toContain('--name')
    expect(args[args.indexOf('--name') + 1]).toBe('dsh-sbx-session-3')
    expect(args).toContain('dsh.sandbox=1')
    expect(args).toContain('dsh.session=session-3')
  })

  it('groups containers of one workspace under one Docker Desktop stack', () => {
    const { provisioner, target } = makeProvisioner()
    const args = provisioner.runArgs(target)
    const label = args.find((a) => a.startsWith('com.docker.compose.project='))
    expect(label).toBeDefined()
    // Same workspace, different sessions: one group. Different workspaces:
    // distinct groups even when the directory names match.
    const project = (label as string).split('=')[1]
    expect(project).toMatch(/^dsh-dsh-sandbox-[0-9a-f]+$/)
    const same = provisioner.runArgs({ ...target, sessionId: 'session-9', container: containerNameFor('session-9') })
    expect(same.find((a) => a.startsWith('com.docker.compose.project='))).toBe(label)
    const other = provisioner.runArgs({ ...target, workspace: 'D:\\Projects\\dsh-sandbox' })
    expect(other.find((a) => a.startsWith('com.docker.compose.project='))).not.toBe(label)
  })

  it('bind-mounts the Windows workspace at the container workspace', () => {
    const { provisioner, target } = makeProvisioner()
    const args = provisioner.runArgs(target)
    expect(args[args.indexOf('-v') + 1]).toBe('F:/Projects/dsh-sandbox:/workspace')
    expect(args[args.indexOf('-w') + 1]).toBe('/workspace')
  })

  it('keeps the container alive with the configured entrypoint', () => {
    const { provisioner, target } = makeProvisioner()
    const args = provisioner.runArgs(target)
    const tail = args.slice(-3)
    expect(tail).toEqual(['alpine:3.20', 'sleep', 'infinity'])
  })

  it('leaves the container unbounded unless limits are configured', () => {
    const { provisioner, target } = makeProvisioner()
    const args = provisioner.runArgs(target)
    expect(args).not.toContain('--cpus')
    expect(args).not.toContain('--memory')

    const bounded = makeProvisioner({}, {
      resourceLimits: { cpu: '2', memory: '2g', memorySwap: '2g' },
    })
    const boundedArgs = bounded.provisioner.runArgs(bounded.target)
    expect(boundedArgs).toContain('--cpus')
    expect(boundedArgs[boundedArgs.indexOf('--cpus') + 1]).toBe('2')
    expect(boundedArgs).toContain('--memory')
    expect(boundedArgs[boundedArgs.indexOf('--memory') + 1]).toBe('2g')
    expect(boundedArgs).toContain('--memory-swap')
    expect(boundedArgs[boundedArgs.indexOf('--memory-swap') + 1]).toBe('2g')
  })

  it('quotes a workspace with spaces as one argv entry', () => {
    const { provisioner } = makeProvisioner()
    const args = provisioner.runArgs({
      sessionId: 'session-3',
      container: 'dsh-sbx-session-3',
      workspace: 'F:\\My Projects\\chat one',
      shared: false,
    })
    expect(args[args.indexOf('-v') + 1]).toBe('F:/My Projects/chat one:/workspace')
  })
})

describe('Provisioner.ensure', () => {
  it('reuses a running container without touching the engine', async () => {
    const { provisioner, calls, target } = makeProvisioner({ state: 'running' })
    await provisioner.ensure(target)

    expect(calls.some((call) => call.args[0] === 'run')).toBe(false)
    expect(calls.some((call) => call.kind === 'execInContainer')).toBe(true)
  })

  it('creates the container, then waits for it to be Running', async () => {
    const { provisioner, calls, target } = makeProvisioner({ state: undefined })
    await provisioner.ensure(target)

    const run = calls.find((call) => call.args[0] === 'run')
    expect(run, 'the run argv must carry the mounts as one entry each').toBeDefined()
    expect(run!.args).toContain('-v')
    const polls = calls.filter((call) => call.args[0] === 'inspect' && call.args[1] === '--format')
    expect(polls.length).toBeGreaterThan(0)
  })

  it('recreates a container that exists but is not running', async () => {
    const { provisioner, calls, target } = makeProvisioner({ state: 'exited' })
    await provisioner.ensure(target)

    expect(calls.some((call) => call.args[0] === 'rm')).toBe(true)
    expect(calls.some((call) => call.args[0] === 'run')).toBe(true)
  })

  it('copies the command runner in when the container is fresh', async () => {
    const { provisioner, calls, target } = makeProvisioner({ state: 'running', probe: 'AGENTS=no\nRG=no' })
    await provisioner.ensure(target)

    const uploads = calls.filter((call) => call.args[2]?.startsWith('cat >'))
    expect(uploads.map((call) => call.args[2])).toEqual(['cat > /tmp/.dsh-run.sh'])
    for (const upload of uploads) expect(String(upload.stdin).length).toBeGreaterThan(0)
  })

  it('shares one provisioning run between concurrent calls for the same chat', async () => {
    const { provisioner, calls, target } = makeProvisioner({ state: undefined })
    await Promise.all([provisioner.ensure(target), provisioner.ensure(target), provisioner.ensure(target)])
    expect(calls.filter((call) => call.args[0] === 'run')).toHaveLength(1)
  })

  it('reports why a container never came up', async () => {
    const { provisioner, target } = makeProvisioner({ state: undefined, runFails: true })
    await expect(provisioner.ensure(target)).rejects.toThrow(/could not be created|Cannot connect/)
  })

  it('refuses to adopt a container it does not own', async () => {
    // A container that merely shares the derived name is not this plugin's to
    // run commands in, and recreating it would delete someone else's work.
    const { provisioner, calls, target } = makeProvisioner({ state: 'running', foreign: true })
    await expect(provisioner.ensure(target)).rejects.toThrow(/does not own/)
    expect(calls.some((call) => call.args[0] === 'rm')).toBe(false)
    expect(calls.some((call) => call.args[0] === 'run')).toBe(false)
  })

  it('does not let one cancelled caller fail the others', async () => {
    const { provisioner, target } = makeProvisioner({ state: undefined })
    const controller = new AbortController()
    const walkingAway = provisioner.ensure(target, { signal: controller.signal })
    const stillWaiting = provisioner.ensure(target)

    controller.abort()

    await expect(walkingAway).rejects.toThrow(/was cancelled/)
    await expect(stillWaiting).resolves.toBe(target)
  })
})

describe('Provisioner.status', () => {
  it('says "absent" for a chat with no container yet', async () => {
    const { provisioner, target } = makeProvisioner({ state: undefined })
    const status = await provisioner.status(target)
    expect(status.phase).toBe('absent')
    expect(status.ready).toBe(false)
    expect(status.container).toBe('dsh-sbx-session-3')
    expect(status.containerWorkspace).toBe('/workspace')
  })

  it('reports the live state and readiness', async () => {
    const { provisioner, target } = makeProvisioner({
      state: 'running',
      inspect: [
        { Name: '/dsh-sbx-session-3', State: { Status: 'running' }, Created: '2026-10-13T08:00:00Z' },
      ],
    })
    const status = await provisioner.status(target)
    expect(status.ready).toBe(true)
    expect(status.phase).toBe('Running')
    expect(status.createdAt).toBe('2026-10-13T08:00:00Z')
  })
})

describe('Provisioner.collectIdle', () => {
  it('releases a container past its idle budget', async () => {
    const { provisioner, calls, target } = makeProvisioner({ state: 'running' }, { idleTtlMs: -1 })
    await provisioner.ensure(target)
    const deleted = await provisioner.collectIdle()

    expect(deleted).toContain('dsh-sbx-session-3')
    expect(calls.some((call) => call.args[0] === 'rm' && call.args[2] === 'dsh-sbx-session-3')).toBe(true)
  })

  it('never reclaims a container whose work is still running', async () => {
    // A build, an install, or a dev server held open in a terminal outlives
    // `idleTtlMs`; the lease is what keeps its container in place.
    const { provisioner, target } = makeProvisioner({ state: 'running' }, { idleTtlMs: -1 })
    await provisioner.ensure(target)

    const release = provisioner.beginWork(target.sessionId)
    expect(await provisioner.collectIdle()).toEqual([])

    release()
    expect(await provisioner.collectIdle()).toContain('dsh-sbx-session-3')
  })

  it('collects an orphan left by an earlier process, but not a fresh one', async () => {
    const { provisioner, calls } = makeProvisioner({
      owned: [
        { id: 'aaa', name: 'dsh-sbx-old-chat', state: 'running', created: '2020-01-01T00:00:00Z', sessionId: 'old-chat' },
        { id: 'bbb', name: 'dsh-sbx-new-chat', state: 'running', created: new Date().toISOString(), sessionId: 'new-chat' },
      ],
    }, { idleTtlMs: 1000 })

    const deleted = await provisioner.collectIdle()
    expect(deleted).toEqual(['dsh-sbx-old-chat'])
    expect(calls.some((call) => call.args[0] === 'rm' && call.args[2] === 'dsh-sbx-new-chat')).toBe(false)
  })

  it('leaves an old container alone while the app still holds its conversation open', async () => {
    // A plugin reload clears the in-memory bookkeeping, which would otherwise
    // make an open chat's container look like an orphan from an earlier run.
    const { provisioner, calls } = makeProvisioner({
      owned: [
        { id: 'aaa', name: 'dsh-sbx-open-chat', state: 'running', created: '2020-01-01T00:00:00Z', sessionId: 'open-chat' },
      ],
    }, { idleTtlMs: 1000 }, { isSessionLive: (sessionId) => sessionId === 'open-chat' })

    expect(await provisioner.collectIdle()).toEqual([])
    expect(calls.some((call) => call.args[0] === 'rm')).toBe(false)
  })
})

describe('Provisioner archive release', () => {
  it('releaseSession deletes the container named after the session', async () => {
    const { provisioner, calls } = makeProvisioner({ state: 'running' })
    await provisioner.releaseSession('session-3')
    expect(calls.some((call) => call.args[0] === 'rm' && call.args[2] === 'dsh-sbx-session-3')).toBe(true)
  })

  it('releaseArchived releases tracked conversations in the archive set only', async () => {
    const { provisioner, calls, target } = makeProvisioner({ state: 'running' })
    await provisioner.ensure(target)

    const deleted = await provisioner.releaseArchived(new Set(['session-3']))
    expect(deleted).toEqual(['dsh-sbx-session-3'])
    expect(calls.some((call) => call.args[0] === 'rm' && call.args[2] === 'dsh-sbx-session-3')).toBe(true)

    const none = await provisioner.releaseArchived(new Set(['session-9']))
    expect(none).toEqual([])
  })

  it('releaseArchived also deletes untracked containers carrying an archived session label', async () => {
    const { provisioner, calls } = makeProvisioner({
      owned: [
        { id: 'aaa', name: 'dsh-sbx-archived-chat', state: 'running', created: new Date().toISOString(), sessionId: 'archived-chat' },
        { id: 'bbb', name: 'dsh-sbx-live-chat', state: 'running', created: new Date().toISOString(), sessionId: 'live-chat' },
      ],
    })

    const deleted = await provisioner.releaseArchived(new Set(['archived-chat']))
    expect(deleted).toEqual(['dsh-sbx-archived-chat'])
    expect(calls.some((call) => call.args[0] === 'rm' && call.args[2] === 'dsh-sbx-archived-chat')).toBe(true)
    expect(calls.some((call) => call.args[0] === 'rm' && call.args[2] === 'dsh-sbx-live-chat')).toBe(false)
  })
})

describe('Provisioner.runArgs with a worktree session', () => {
  it('mounts the main .git and pins GIT_DIR/GIT_WORK_TREE for the session', () => {
    const config = testConfig()
    const { transport } = fakeTransport()
    const paths = new PathMapper('workspace', config.containerWorkspace)
    const worktree = 'F:\\Projects\\dsh-sandbox.worktrees\\session-3'
    paths.registerExtraMount(worktree, {
      mount: { hostPath: 'F:/Projects/dsh-sandbox/.git', containerPath: '/f/Projects/dsh-sandbox/.git' },
      containerGitDir: '/f/Projects/dsh-sandbox/.git/worktrees/session-3',
      gitConfig: { 'core.autocrlf': 'true', 'user.name': 'Ada', 'user.email': 'ada@example.com' },
    })
    const provisioner = new Provisioner(transport, config, paths)
    const args = provisioner.runArgs({
      sessionId: 'session-3',
      container: containerNameFor('session-3'),
      workspace: worktree,
      shared: false,
      mainWorkspace: WINDOWS,
    })
    expect(args).toContain('GIT_DIR=/f/Projects/dsh-sandbox/.git/worktrees/session-3')
    expect(args).toContain('GIT_WORK_TREE=/workspace')
    expect(args).toContain('GIT_CONFIG_COUNT=3')
    expect(args).toContain('GIT_CONFIG_KEY_0=core.autocrlf')
    expect(args).toContain('GIT_CONFIG_VALUE_0=true')
    expect(args).toContain('GIT_CONFIG_KEY_2=user.email')
    expect(args).toContain('GIT_CONFIG_VALUE_2=ada@example.com')
    const volumes = args.filter((arg, index) => args[index - 1] === '-v')
    expect(volumes).toContain('F:/Projects/dsh-sandbox/.git:/f/Projects/dsh-sandbox/.git')
    expect(volumes).toContain('F:/Projects/dsh-sandbox.worktrees/session-3:/workspace')
  })
})

describe('Provisioner.ensure liveness guard', () => {
  it('refuses to raise a container for an archived conversation', async () => {
    const { provisioner, calls, target } = makeProvisioner(
      { state: undefined },
      {},
      { isSessionArchived: (id) => id === 'session-3' },
    )
    await expect(provisioner.ensure(target)).rejects.toMatchObject({ code: 'SESSION_ARCHIVED' })
    expect(calls.some((call) => call.args[0] === 'run')).toBe(false)
  })

  it('refuses a conversation the session store no longer holds', async () => {
    const { provisioner, calls, target } = makeProvisioner(
      { state: undefined },
      {},
      { isSessionLive: () => false },
    )
    await expect(provisioner.ensure(target)).rejects.toMatchObject({ code: 'SESSION_GONE' })
    expect(calls.some((call) => call.args[0] === 'run')).toBe(false)
  })

  it('exempts the shared agentless container from the guard', async () => {
    const { provisioner, calls } = makeProvisioner(
      { state: undefined },
      {},
      { isSessionLive: () => false, isSessionArchived: () => true },
    )
    const shared = {
      sessionId: 'default',
      container: containerNameFor('default'),
      workspace: WINDOWS,
      shared: true,
    }
    await provisioner.ensure(shared)
    expect(calls.some((call) => call.args[0] === 'run')).toBe(true)
  })

  it('provisions normally when the app reports the session live', async () => {
    const { provisioner, calls, target } = makeProvisioner(
      { state: undefined },
      {},
      { isSessionLive: () => true, isSessionArchived: () => false },
    )
    await provisioner.ensure(target)
    expect(calls.some((call) => call.args[0] === 'run')).toBe(true)
  })
})
