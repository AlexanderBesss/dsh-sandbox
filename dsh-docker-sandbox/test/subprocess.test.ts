import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { DockerSubprocessRuntime, isPackagedRipgrep } from '../src/subprocess.ts'
import { OutputTail } from '../src/output-tail.ts'
import { PathMapper } from '../src/paths.ts'
import type { Provisioner } from '../src/provisioner.ts'
import type { DockerTransport } from '../src/transport.ts'
import type { SandboxContext } from '../src/context.ts'
import { testConfig } from './helpers.ts'

const WORKSPACE = 'F:\\Projects\\dsh-sandbox'

const okResult = (stdout = '') => ({
  code: 0,
  stdout: Buffer.from(stdout),
  stderr: Buffer.alloc(0),
  truncated: false,
  stdoutTruncated: false,
  stderrTruncated: false,
})

function makeRuntime(transport: DockerTransport): DockerSubprocessRuntime {
  const ctx = {
    agents: { currentInitiator: () => ({ id: 'session-1', session: { id: 'session-1', header: { cwd: WORKSPACE } } }) },
    sessions: { get: () => undefined },
  } as unknown as SandboxContext
  const config = testConfig()
  return new DockerSubprocessRuntime(ctx, {
    transport,
    provisioner: { ensure: async () => undefined, beginWork: () => () => undefined, touch: () => undefined } as unknown as Provisioner,
    paths: new PathMapper('workspace', config.containerWorkspace),
    config,
  })
}

describe('OutputTail', () => {
  it('keeps short output whole and counts every byte it saw', () => {
    const tail = new OutputTail(64)
    tail.append(Buffer.from('hello '))
    tail.append(Buffer.from('world'))
    expect(tail.text).toBe('hello world')
    expect(tail.bytes).toBe(11)
    expect(tail.lossy).toBe(false)
  })

  it('serves an incremental read from an absolute offset', () => {
    const tail = new OutputTail(64)
    tail.append(Buffer.from('hello world'))
    expect(tail.readFrom(6)?.text).toBe('world')
    expect(tail.readFrom(11)?.text).toBe('')
    expect(tail.readFrom(0)?.text).toBe('hello world')
  })

  it('answers an empty stream with empty text, never undefined', () => {
    // The shipped search provider reads `collected.stderr.readFrom(0)` on
    // every ripgrep run; `undefined` reads as "no collected output streams"
    // and fails the search even when stdout is full.
    expect(new OutputTail(16).readFrom(0)).toEqual({ text: '', nextOffset: 0, lossy: false })
  })

  it('retains only the tail once the budget is exceeded', () => {
    const tail = new OutputTail(10)
    tail.append(Buffer.from('abcde'))
    tail.append(Buffer.from('fghij'))
    tail.append(Buffer.from('kl'))

    expect(tail.bytes).toBe(12)
    expect(tail.text).toBe('fghijkl')
    expect(tail.lossy).toBe(true)
    // The caller asked for offset 0, which is gone: the read says so.
    expect(tail.readFrom(0)).toEqual({ text: 'fghijkl', nextOffset: 12, lossy: true })
  })

  it('drops a chunk larger than the budget down to its last bytes', () => {
    const tail = new OutputTail(8)
    tail.append(Buffer.from('0123456789'))
    expect(tail.text).toBe('23456789')
    expect(tail.lossy).toBe(true)
  })
})

describe('isPackagedRipgrep', () => {
  it('recognises the ripgrep binary the app ships', () => {
    expect(isPackagedRipgrep('C:\\app\\node_modules\\@vscode\\ripgrep-win32-x64\\bin\\rg.exe')).toBe(true)
  })

  it('does not treat an arbitrary Windows rg as the packaged one', () => {
    expect(isPackagedRipgrep('F:\\tools\\rg.exe')).toBe(false)
    expect(isPackagedRipgrep('rg')).toBe(false)
  })
})

describe('DockerSubprocessRuntime.resolveExecutable', () => {
  it('passes the name as its own argv element, never into the script', async () => {
    // A name carrying `$(...)` must not be expanded by the container shell.
    const calls: string[][] = []
    const transport = {
      execInContainer: (_target: unknown, argv: string[]) => {
        calls.push(argv)
        return Promise.resolve(okResult('/usr/bin/rg\n'))
      },
    } as unknown as DockerTransport
    const runtime = makeRuntime(transport)
    expect(await runtime.resolveExecutable!('rg; $(id)')).toBe('/usr/bin/rg')
    expect(calls[0]!.slice(0, 3)).toEqual(['sh', '-c', 'command -v "$1" 2>/dev/null'])
    expect(calls[0]![4]).toBe('rg; $(id)')
  })
})

describe('DockerSubprocessRuntime.waitForExit', () => {
  it('leaves a running command alone until a termination is requested', async () => {
    // The handle type allows waitForExit as a plain "await the process"; the
    // grace-period escalation must not arm by itself and SIGKILL a healthy run.
    let killed = false
    const exit = Promise.withResolvers<{ code: number | null; signal: string | null }>()
    const transport = {
      spawnInContainer: () => ({
        child: { pid: 1, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => { killed = true } },
        done: exit.promise,
        kill: () => { killed = true },
      }),
      execInContainer: () => Promise.resolve(okResult('NOPID\n')),
    } as unknown as DockerTransport
    const runtime = makeRuntime(transport)
    const handle = runtime.spawn({ argv: ['sh', '-c', 'sleep 1'], graceMs: 50 })
    const waiting = handle.waitForExit()
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(killed, 'waitForExit alone must not signal the process').toBe(false)
    exit.resolve({ code: 0, signal: null })
    expect(await waiting).toBe(true)
  })

  it('escalates after terminate, as before', async () => {
    let killed = false
    const exit = Promise.withResolvers<{ code: number | null; signal: string | null }>()
    const transport = {
      spawnInContainer: () => ({
        child: { pid: 1, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => { killed = true } },
        done: exit.promise,
        kill: () => { killed = true },
      }),
      execInContainer: () => Promise.resolve(okResult('SIGNALED\n')),
    } as unknown as DockerTransport
    const runtime = makeRuntime(transport)
    const handle = runtime.spawn({ argv: ['sh', '-c', 'sleep 1'], graceMs: 50 })
    handle.terminate()
    const waiting = handle.waitForExit()
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(killed, 'terminate then waitForExit must escalate').toBe(true)
    exit.resolve({ code: null, signal: 'SIGKILL' })
    expect(await waiting).toBe(false)
  })

  it('escalates when the termination lands during the wait', async () => {
    // The shipped local executor escalates TERM→KILL regardless of who is
    // awaiting; a caller that starts waiting first and is cancelled second
    // must not hang on a SIGTERM-ignoring process.
    let killed = false
    const exit = Promise.withResolvers<{ code: number | null; signal: string | null }>()
    const transport = {
      spawnInContainer: () => ({
        child: { pid: 1, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => { killed = true } },
        done: exit.promise,
        kill: () => { killed = true },
      }),
      execInContainer: () => Promise.resolve(okResult('SIGNALED\n')),
    } as unknown as DockerTransport
    const runtime = makeRuntime(transport)
    const handle = runtime.spawn({ argv: ['sh', '-c', 'sleep 1'], graceMs: 50 })
    const waiting = handle.waitForExit()
    handle.terminate()
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(killed, 'a termination during the wait must still escalate to KILL').toBe(true)
    exit.resolve({ code: null, signal: 'SIGKILL' })
    expect(await waiting).toBe(false)
  })
})
