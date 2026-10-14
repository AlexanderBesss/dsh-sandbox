import type { DockerTransport } from '../src/container/transport.ts'
import { SandboxUnavailableError } from '../src/container/transport.ts'
import type { SandboxConfig } from '../src/config.ts'

type Plain<T> = T extends { get(): infer U } ? U
  : T extends readonly unknown[] ? T
  : T extends object ? { [K in keyof T]: Plain<T[K]> }
  : T

type PlainPartial<T> = T extends object ? { [K in keyof T]?: PlainPartial<T[K]> } : T

function ref<T>(v: T): { get(): T } {
  return { get: () => v }
}

export function testConfig(overrides: PlainPartial<Plain<SandboxConfig>> = {}): SandboxConfig {
  const plain = {
    dockerArgv: ['docker'],
    image: 'alpine:3.20',
    command: ['sleep', 'infinity'],
    mountMode: 'workspace',
    containerWorkspace: '/workspace',
    workspaceRoot: 'F:\\Projects\\dsh-sandbox',
    allowAgentless: false,
    provisionTimeoutMs: 120000,
    timeoutMs: 120000,
    maxTimeoutMs: 600000,
    maxOutputBytes: 64000,
    graceMs: 3000,
    shellArgv: ['/bin/sh', '-lc'],
    pwshGuard: true,
    bootstrapTools: true,
    ripgrepSource: 'package',
    idleTtlMs: 7200000,
    gcIntervalMs: 60000,
    terminalPty: false,
    resourceLimits: { cpu: '', memory: '', memorySwap: '' },
    gcOnUnload: false,
    worktree: false,
    worktreeRoot: '',
    worktreeBranchPrefix: 'dsh-sbx/',
    npmCacheHost: '',
    worktreeInstall: true,
    warmInstallTimeoutMs: 600000,
    prBrief: true,
    prBriefTimeoutMs: 120000,
    gitArgv: ['git'],
    ghArgv: ['gh'],
    ...overrides,
  }
  plain.resourceLimits = { cpu: '', memory: '', memorySwap: '', ...overrides.resourceLimits }
  return {
    ...plain,
    image: ref(plain.image),
    timeoutMs: ref(plain.timeoutMs),
    maxTimeoutMs: ref(plain.maxTimeoutMs),
    maxOutputBytes: ref(plain.maxOutputBytes),
    graceMs: ref(plain.graceMs),
    idleTtlMs: ref(plain.idleTtlMs),
    worktree: ref(plain.worktree),
    worktreeRoot: ref(plain.worktreeRoot),
    worktreeInstall: ref(plain.worktreeInstall),
    prBrief: ref(plain.prBrief),
    resourceLimits: {
      cpu: ref(plain.resourceLimits.cpu),
      memory: ref(plain.resourceLimits.memory),
      memorySwap: ref(plain.resourceLimits.memorySwap),
    },
  } as unknown as SandboxConfig
}

export interface RecordedCall {
  kind: 'docker' | 'dockerJson' | 'execInContainer'
  args: string[]
  target?: { container: string }
  stdin?: Buffer | string
}

export interface FakeEngine {
  state?: string
  inspect?: unknown[]
  owned?: { id: string; name: string; state: string; created?: string; sessionId?: string }[]
  probe?: string
  runFails?: boolean
  engineDown?: boolean
  foreign?: boolean
}

export function fakeTransport(engine: FakeEngine = {}): { transport: DockerTransport; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  let state = engine.state
  const ok = {
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    code: 0,
    truncated: false,
    stdoutTruncated: false,
    stderrTruncated: false,
  }
  const fail = (message: string): never => {
    throw new SandboxUnavailableError(message, 'EXEC_FAILED', message)
  }

  const inspectOf = (entry: NonNullable<FakeEngine['owned']>[number]) => ({
    Name: `/${entry.name}`,
    State: { Status: entry.state },
    Created: entry.created,
    Config: { Labels: entry.sessionId === undefined ? {} : { 'dsh.session': entry.sessionId } },
  })

  const transport = {
    async docker(args: string[], opts: { stdin?: Buffer | string } = {}) {
      calls.push({ kind: 'docker', args, ...(opts.stdin === undefined ? {} : { stdin: opts.stdin }) })
      if (args[0] === 'version') {
        if (engine.engineDown === true) fail('Cannot connect to the Docker daemon at npipe:////./pipe/docker_engine. Is the docker daemon running?')
        return { ...ok, stdout: Buffer.from('27.3.1\n') }
      }
      if (args[0] === 'run') {
        if (engine.runFails === true) fail('Error response from daemon: Cannot connect to the Docker daemon at npipe')
        state = 'running'
        return { ...ok, stdout: Buffer.from('deadbeef\n') }
      }
      if (args[0] === 'inspect' && args[1] === '--format') {
        if (state === undefined) fail(`Error: No such object: ${args[3]}`)
        const labels = engine.foreign === true ? 'map[someone-elses:yes]' : 'map[dsh.sandbox:1]'
        return { ...ok, stdout: Buffer.from(`${state}|${labels}\n`) }
      }
      if (args[0] === 'ps') {
        return { ...ok, stdout: Buffer.from((engine.owned ?? []).map((entry) => entry.id).join('\n')) }
      }
      if (args[0] === 'rm') {
        state = undefined
        return ok
      }
      return ok
    },
    async dockerJson<T>(args: string[]) {
      calls.push({ kind: 'dockerJson', args })
      if (args[0] !== 'inspect') fail(`unexpected dockerJson call: ${args.join(' ')}`)
      if (args.length > 2) return (engine.owned ?? []).map(inspectOf) as unknown as T
      if (engine.inspect === undefined && state === undefined) fail(`Error: No such object: ${args[1]}`)
      return (engine.inspect ?? [{ Name: `/${args[1]}`, State: { Status: state }, Created: '2026-10-13T08:00:00Z' }]) as unknown as T
    },
    async execInContainer(target: { container: string }, argv: string[], opts: { stdin?: Buffer | string } = {}) {
      calls.push({ kind: 'execInContainer', args: argv, target, ...(opts.stdin === undefined ? {} : { stdin: opts.stdin }) })
      if (argv[2]?.includes('AGENTS=')) {
        return { ...ok, stdout: Buffer.from(engine.probe ?? 'AGENTS=yes\nRG=yes') }
      }
      return ok
    },
  }

  return { transport: transport as unknown as DockerTransport, calls }
}
