/**
 * The shell handle's incremental output reader.
 *
 * stdout and stderr are independent byte streams, so each needs its own cursor;
 * a shared one re-emits output a caller already received, which is what these
 * tests pin down.
 */

import { describe, expect, it } from 'vitest'
import { DockerShellExecutor } from '../src/shell.ts'
import { type DockerSubprocessRuntime } from '../src/subprocess.ts'
import { OutputTail } from '../src/output-tail.ts'
import { PathMapper } from '../src/paths.ts'
import type { Provisioner } from '../src/provisioner.ts'
import { testConfig } from './helpers.ts'
import type { SandboxContext } from '../src/context.ts'

const WORKSPACE = 'F:\\Projects\\dsh-sandbox'

interface FakeHandle {
  collected: { stdout: OutputTail; stderr: OutputTail }
  done: Promise<{ exitCode: number | null; signal: string | null; killed: boolean }>
  terminate(): void
  waitForExit(): Promise<boolean>
}

/** A live handle whose output the test feeds by hand. */
function fakeHandle(options: { exit?: { exitCode: number | null; signal: string | null; killed: boolean } } = {}): FakeHandle & {
  stdout: OutputTail
  stderr: OutputTail
} {
  const stdout = new OutputTail(1000)
  const stderr = new OutputTail(1000)
  return {
    collected: { stdout, stderr },
    stdout,
    stderr,
    // No `exit` means a background process nobody has awaited yet: `done` stays
    // open so the test can poll `readOutput` while it is still running.
    done: options.exit === undefined
      ? new Promise(() => undefined)
      : Promise.resolve(options.exit),
    terminate: () => undefined,
    waitForExit: async () => true,
  }
}

function makeExecutor(
  handle: FakeHandle,
  initiator: { id: string; session?: { id: string; header?: { cwd?: string } } } | null = {
    id: 'session-1',
    session: { id: 'session-1', header: { cwd: WORKSPACE } },
  },
): DockerShellExecutor {
  const ctx = {
    agents: { currentInitiator: () => initiator ?? undefined },
    sessions: { get: () => undefined },
  } as unknown as SandboxContext
  const config = testConfig()
  return new DockerShellExecutor(ctx, {
    subprocess: { spawn: () => handle } as unknown as DockerSubprocessRuntime,
    provisioner: { ensure: async () => undefined } as unknown as Provisioner,
    paths: new PathMapper('workspace', config.containerWorkspace),
    config,
  })
}

describe('DockerShellExecutor.readOutput', () => {
  it('advances each stream on its own cursor', async () => {
    const handle = fakeHandle()
    const process = await makeExecutor(handle).execute({ command: 'make' })

    handle.stderr.append(Buffer.from('warning one\n'))
    expect(process.readOutput().delta).toContain('warning one')

    handle.stderr.append(Buffer.from('warning two\n'))
    // A cursor shared with stdout never moved (stdout produced nothing), so a
    // shared cursor would hand the first warning back a second time.
    const second = process.readOutput().delta
    expect(second).toContain('warning two')
    expect(second).not.toContain('warning one')

    handle.stdout.append(Buffer.from('built\n'))
    handle.stderr.append(Buffer.from('warning three\n'))
    const next = process.readOutput().delta
    expect(next).toContain('built')
    expect(next).toContain('warning three')
    expect(next).not.toContain('warning two')

    // Everything consumed: the next poll is empty rather than a repeat.
    expect(process.readOutput().delta).toBe('')
  })

  it('keeps a stderr stream longer than stdout from replaying its head', async () => {
    const handle = fakeHandle()
    const process = await makeExecutor(handle).execute({ command: 'git push' })

    handle.stderr.append(Buffer.from('remote: one\nremote: two\n'))
    handle.stdout.append(Buffer.from('ok\n'))
    expect(process.readOutput().delta).toContain('remote: two')

    handle.stderr.append(Buffer.from('remote: three\n'))
    const next = process.readOutput().delta
    expect(next).toContain('remote: three')
    expect(next).not.toContain('remote: one')
  })
})

describe('DockerShellExecutor.execute', () => {
  it('clamps a caller deadline to maxTimeoutMs and reports the deadline that applied', async () => {
    const handle = fakeHandle({ exit: { exitCode: 0, signal: null, killed: false } })
    const config = testConfig()
    const process = await makeExecutor(handle).execute({ command: 'true', timeoutMs: config.maxTimeoutMs.get() + 60_000 })
    const result = await process.result()
    expect(result.timeoutMs).toBe(config.maxTimeoutMs.get())
  })

  it('fills the deadline on a resolved spec (the pwsh tool hands it to the jobs registry)', async () => {
    const handle = fakeHandle({ exit: { exitCode: 0, signal: null, killed: false } })
    const config = testConfig()
    const spec = makeExecutor(handle).resolve({ command: 'true' })
    expect(spec.timeoutMs).toBe(config.timeoutMs.get())
    expect(spec.onExpiry).toBe('kill')
  })

  it('keeps a stamped spec on the container it was resolved for', async () => {
    // The stamp is the binding: executing later — while another chat is the
    // initiator — must not re-route the command into that chat's container.
    const handle = fakeHandle({ exit: { exitCode: 0, signal: null, killed: false } })
    const stamped = makeExecutor(handle).resolve({ command: 'true' })
    expect(stamped.container).toBe('dsh-sbx-session-1')

    const later = makeExecutor(handle, { id: 'session-2', session: { id: 'session-2', header: { cwd: 'F:\\Projects\\other' } } })
    const process = await later.execute(stamped)
    expect(process.details?.container).toBe('dsh-sbx-session-1')
  })

  it('still refuses an unstamped spec that cannot name its chat', async () => {
    const handle = fakeHandle({ exit: { exitCode: 0, signal: null, killed: false } })
    const orphan = makeExecutor(handle, null)
    await expect(orphan.execute({ command: 'true' })).rejects.toThrow(/not running inside a conversation/)
  })
})
