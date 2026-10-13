/**
 * The `shell` terminal backend.
 *
 * Two things these tests pin down: the conversation a terminal belongs to comes
 * from the spawn request (a terminal is opened from the UI, where no agent
 * chain is running), and a send settles only on its own completion marker.
 */

import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import type { TerminalSessionId } from '@deepseek-ai/dsh-terminal'
import { createShellBackend } from '../src/terminal.ts'
import { PathMapper } from '../src/paths.ts'
import { containerNameFor } from '../src/session.ts'
import type { Provisioner } from '../src/provisioner.ts'
import type { DockerTransport, LiveProcess } from '../src/transport.ts'
import type { SandboxContext } from '../src/context.ts'
import { testConfig } from './helpers.ts'

const WORKSPACE = 'F:\\Projects\\dsh-sandbox'

interface FakeLive {
  child: { pid: number; stdin: PassThrough; stdout: PassThrough; stderr: PassThrough }
  done: Promise<{ code: number | null; signal: string | null }>
  kill(): void
}

function fakeLive(): FakeLive {
  return {
    child: { pid: 4242, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() },
    done: new Promise(() => undefined),
    kill: () => undefined,
  }
}

function makeBackend(live: FakeLive): { backend: ReturnType<typeof createShellBackend>; spawned: string[]; execed: string[][] } {
  const spawned: string[] = []
  const execed: string[][] = []
  const transport = {
    spawnInContainer: (target: { container: string }) => {
      spawned.push(target.container)
      return live as unknown as LiveProcess
    },
    execInContainer: (_target: { container: string }, argv: string[]) => {
      execed.push(argv)
      return Promise.resolve({ code: 0, stdout: Buffer.from('SIGNALED\n'), stderr: Buffer.alloc(0), truncated: false, stdoutTruncated: false, stderrTruncated: false })
    },
  } as unknown as DockerTransport
  const provisioner = {
    ensure: async () => undefined,
    beginWork: () => () => undefined,
    touch: () => undefined,
  } as unknown as Provisioner
  // No initiating agent: this is what the terminal panel looks like to the plugin.
  const ctx = {
    agents: { currentInitiator: () => undefined },
    sessions: { get: (id: string) => ({ id, header: { cwd: WORKSPACE } }) },
  } as unknown as SandboxContext
  // Short grace: `close()` escalates TERM→KILL after `graceMs`, and the fake
  // live process never exits on its own, so the default 3 s would just slow
  // every test down.
  const config = testConfig({ graceMs: 50 })
  const backend = createShellBackend(ctx, {
    transport,
    provisioner,
    paths: new PathMapper('workspace', config.containerWorkspace),
    config,
  })
  return { backend, spawned, execed }
}

const SESSION = 'chat-9' as TerminalSessionId

describe('shell terminal backend', () => {
  it('routes the session the request names, with no agent in the chain', async () => {
    const live = fakeLive()
    const { backend, spawned } = makeBackend(live)

    const session = await backend.spawn({ sessionId: SESSION, owner: 'ui', type: 'shell' })

    expect(spawned).toEqual([containerNameFor(SESSION)])
    expect(session.motd).toContain(containerNameFor(SESSION))
    await session.close('done')
  })

  it('settles a send on its own marker and reports the exit code', async () => {
    const live = fakeLive()
    const { backend } = makeBackend(live)
    const session = await backend.spawn({ sessionId: SESSION, owner: 'ui', type: 'shell' })

    const send = session.startSend({ text: 'echo hi' })
    live.child.stdout.write('hi\n')
    live.child.stdout.write('\n__DSH_DONE_1__ 0\n')

    const result = await send.done
    expect(result.waitReason).toBe('stdin_read')
    expect(result.viewport).toBe('hi\n[exit 0]')
    await session.close('done')
  })

  it('ignores a marker left over from a send that already timed out', async () => {
    const live = fakeLive()
    const { backend } = makeBackend(live)
    const session = await backend.spawn({ sessionId: SESSION, owner: 'ui', type: 'shell' })

    const first = session.startSend({ text: 'sleep 30', timeoutMs: 1 })
    expect((await first.done).waitReason).toBe('timeout')

    const second = session.startSend({ text: 'echo hi' })
    // The stale verdict arrives late: it must not settle the new send, and it
    // must not show up in the new send's viewport as output.
    live.child.stdout.write('__DSH_DONE_1__ 0\n')
    live.child.stdout.write('hi\n')
    live.child.stdout.write('\n__DSH_DONE_2__ 0\n')

    const result = await second.done
    expect(result.waitReason).toBe('stdin_read')
    expect(result.viewport).toBe('hi\n[exit 0]')
    await session.close('done')
  })

  it('does not let a stale abort settle the send that runs next', async () => {
    // The first send finished on its marker; aborting its signal afterwards
    // (caller cleanup) must not settle the second send early.
    const live = fakeLive()
    const { backend } = makeBackend(live)
    const session = await backend.spawn({ sessionId: SESSION, owner: 'ui', type: 'shell' })

    const controller = new AbortController()
    const first = session.startSend({ text: 'echo one', signal: controller.signal })
    live.child.stdout.write('\n__DSH_DONE_1__ 0\n')
    expect((await first.done).waitReason).toBe('stdin_read')

    const second = session.startSend({ text: 'sleep 30', timeoutMs: 5000 })
    controller.abort()

    live.child.stdout.write('\n__DSH_DONE_2__ 0\n')
    const result = await second.done
    expect(result.waitReason).toBe('stdin_read')
    await session.close('done')
  })

  it('signals the session shell process group when closing', async () => {
    // Killing the local docker client does not stop the in-container command;
    // close must signal the group the runner recorded.
    const live = fakeLive()
    const { backend, execed } = makeBackend(live)
    const session = await backend.spawn({ sessionId: SESSION, owner: 'ui', type: 'shell' })
    await session.close('done')
    const signalled = execed.some((argv) => argv.join(' ').includes('/tmp/.dsh-pid-dsh-t'))
    expect(signalled, 'close must signal the runner pidfile').toBe(true)
  })

  it('escalates a close to KILL when the session shell ignores TERM', async () => {
    // The fake live process never exits, standing in for a command that traps
    // or ignores SIGTERM; close must escalate after the grace period rather
    // than leave it running until the GC deletes the container.
    const live = fakeLive()
    const { backend, execed } = makeBackend(live)
    const session = await backend.spawn({ sessionId: SESSION, owner: 'ui', type: 'shell' })
    await session.close('done')
    const joined = execed.map((argv) => argv.join(' '))
    expect(joined.some((s) => s.includes('kill -TERM')), 'close must TERM first').toBe(true)
    expect(joined.some((s) => s.includes('kill -KILL')), 'close must escalate to KILL').toBe(true)
  })

  it('keeps the completion sentinel out of the transcript the panel reads back', async () => {
    // The marker is protocol, not output: it must not appear in `read()` any
    // more than it appears in a send's delta.
    const live = fakeLive()
    const { backend } = makeBackend(live)
    const session = await backend.spawn({ sessionId: SESSION, owner: 'ui', type: 'shell' })

    const send = session.startSend({ text: 'echo hi' })
    live.child.stdout.write('hi\n')
    live.child.stdout.write('\n__DSH_DONE_1__ 0\n')
    await send.done

    const read = await session.read()
    expect(read.text).toContain('hi')
    expect(read.text, 'sentinel leaked into the transcript').not.toContain('__DSH_DONE_')
    await session.close('done')
  })

  it('signals the recorded group for a supported signal, keeping the pidfile', async () => {
    const live = fakeLive()
    const { backend, execed } = makeBackend(live)
    const session = await backend.spawn({ sessionId: SESSION, owner: 'ui', type: 'shell' })

    await session.signal('SIGINT')

    const killArgv = execed.find((argv) => argv.join(' ').includes('kill -INT'))
    expect(killArgv, 'signal must reach the recorded process group').toBeDefined()
    // The session lives on after a signal; its next signal (and its close)
    // still need the recorded group, so the pidfile must survive.
    expect(killArgv!.join(' ')).not.toContain('rm -f')
    await session.close('done')
  })

  it('refuses a signal the group kill cannot carry', async () => {
    const live = fakeLive()
    const { backend } = makeBackend(live)
    const session = await backend.spawn({ sessionId: SESSION, owner: 'ui', type: 'shell' })
    await expect(session.signal('SIGWINCH')).rejects.toThrow(/not available/)
    await session.close('done')
  })
})
