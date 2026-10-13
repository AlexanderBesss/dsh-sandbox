/**
 * Shared test fixtures: a full config object and a recording transport.
 *
 * `testConfig` spells out every field on purpose. When the schema grows, the
 * typecheck fails here first, which is the cheapest place to notice that a new
 * option needs a default and a test.
 */

import type { DockerTransport } from '../src/container/transport.ts'
import { SandboxUnavailableError } from '../src/container/transport.ts'
import type { SandboxConfig } from '../src/config.ts'

/** Unwrap `Volatile` references so tests can spell plain values. */
type Plain<T> = T extends { get(): infer U } ? U
  : T extends readonly unknown[] ? T
  : T extends object ? { [K in keyof T]: Plain<T[K]> }
  : T

/** Deep-partial over the plain view, so overrides stay terse. */
type PlainPartial<T> = T extends object ? { [K in keyof T]?: PlainPartial<T[K]> } : T

/** Minimal stand-in for a runtime volatile reference. */
function ref<T>(v: T): { get(): T } {
  return { get: () => v }
}

/** A complete {@link SandboxConfig}, with `overrides` applied. */
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
    gitArgv: ['git'],
    ghArgv: ['gh'],
    ...overrides,
  }
  plain.resourceLimits = { cpu: '', memory: '', memorySwap: '', ...overrides.resourceLimits }
  // The runtime wraps every `volatile()` schema leaf in a reference; the
  // fixture mirrors that so consumption sites read through `.get()` here too.
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
    resourceLimits: {
      cpu: ref(plain.resourceLimits.cpu),
      memory: ref(plain.resourceLimits.memory),
      memorySwap: ref(plain.resourceLimits.memorySwap),
    },
  } as unknown as SandboxConfig
}

/** One recorded transport call. */
export interface RecordedCall {
  kind: 'docker' | 'dockerJson' | 'execInContainer'
  args: string[]
  target?: { container: string }
  stdin?: Buffer | string
}

/** Scripted answers for a fake engine. */
export interface FakeEngine {
  /** Answer for `docker inspect --format {{.State.Status}} …`; undefined means "no such container". */
  state?: string
  /** Answer for `docker inspect <name>` (JSON form). */
  inspect?: unknown[]
  /** Containers the engine holds for this plugin (`docker ps -aq --filter label=…`). */
  owned?: { id: string; name: string; state: string; created?: string; sessionId?: string }[]
  /** Text the in-container probe script prints. */
  probe?: string
  /** Fail `docker run`. */
  runFails?: boolean
  /** The container already holding this name is not one this plugin owns. */
  foreign?: boolean
}

/** A {@link DockerTransport} stand-in that records every call it receives. */
export function fakeTransport(engine: FakeEngine = {}): { transport: DockerTransport; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  // The fake engine tracks container existence the way the real one does:
  // `engine.state` is the state before the test acts, `docker run` makes the
  // container Running, and `docker rm` removes it again.
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
      if (args[0] === 'run') {
        if (engine.runFails === true) fail('Error response from daemon: Cannot connect to the Docker daemon at npipe')
        state = 'running'
        return { ...ok, stdout: Buffer.from('deadbeef\n') }
      }
      if (args[0] === 'inspect' && args[1] === '--format') {
        if (state === undefined) fail(`Error: No such object: ${args[3]}`)
        // The real format string renders `<state>|map[dsh.sandbox:1 …]`.
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
      // `docker inspect <id> <id>…` for the owned sweep vs `docker inspect <name>`.
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
