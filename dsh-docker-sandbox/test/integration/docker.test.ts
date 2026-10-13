/**
 * Integration test against the live Docker engine.
 *
 * Skipped unless `DSH_DOCKER=1`, because it needs Docker Desktop (or another
 * reachable engine). Run it with `pnpm test:integration`. It provisions a real
 * per-chat container, exercises the command runner, cancellation, and the
 * bind mount, and deletes the container again.
 */

import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { PathMapper } from '../../src/paths.ts'
import { Provisioner } from '../../src/provisioner.ts'
import { containerNameFor } from '../../src/session.ts'
import { DockerTransport } from '../../src/transport.ts'
import { testConfig } from '../helpers.ts'

const enabled = process.env.DSH_DOCKER === '1'

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 })

describe.skipIf(!enabled)('live Docker sandbox', () => {
  const config = testConfig()
  const transport = new DockerTransport(config)
  const paths = new PathMapper('workspace', config.containerWorkspace)
  const provisioner = new Provisioner(transport, config, paths)

  const sessionId = `itest-${Date.now()}`
  const target = {
    sessionId,
    container: containerNameFor(sessionId),
    workspace: process.cwd(),
    shared: false,
  }
  afterAll(async () => {
    if (!enabled) return
    await provisioner.release(target)
  })

  it('provisions a container for one conversation and runs a command in it', async () => {
    await provisioner.ensure(target)
    const status = await provisioner.status(target)
    expect(status.ready).toBe(true)
    expect(status.container).toBe(target.container)

    const result = await transport.execInContainer(target, ['sh', '-c', 'echo hi; pwd; test -f /tmp/.dsh-run.sh && echo AGENT=yes'], { timeoutMs: 60_000 })
    const text = result.stdout.toString('utf8')
    expect(result.code).toBe(0)
    expect(text).toContain('hi')
    expect(text).toContain('/workspace')
    expect(text).toContain('AGENT=yes')
  })

  it('gives the conversation ripgrep so search works', async () => {
    const result = await transport.execInContainer(target, ['sh', '-c', 'command -v rg || echo MISSING'], { timeoutMs: 60_000 })
    expect(result.stdout.toString('utf8').trim()).not.toBe('MISSING')
  })

  it('runs a command through the process agent', async () => {
    const result = await transport.execInContainer(
      target,
      ['sh', '/tmp/.dsh-run.sh', 'op-integration', '-', 'sh', '-c', 'echo "$PWD"; echo hello'],
      { timeoutMs: 60_000 },
    )
    expect(result.code).toBe(0)
    expect(result.stdout.toString('utf8')).toContain('hello')
  })

  it('stops a running command by signalling its process group', async () => {
    const live = transport.spawnInContainer(target, ['sh', '/tmp/.dsh-run.sh', 'op-kill', '-', 'sleep', '120'])

    // The runner records the pid it exec'd; that pid is also the process group.
    let pid = ''
    for (let attempt = 0; attempt < 20 && pid === ''; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 500))
      const read = await transport.execInContainer(target, ['sh', '-c', 'cat /tmp/.dsh-pid-op-kill 2>/dev/null'], { timeoutMs: 30_000 })
      pid = read.stdout.toString('utf8').trim()
    }
    expect(pid).toMatch(/^[0-9]+$/)

    await transport.execInContainer(target, ['sh', '-c', `kill -TERM -"${pid}" 2>/dev/null; rm -f /tmp/.dsh-pid-op-kill`], { timeoutMs: 30_000 })
    const outcome = await live.done
    expect(outcome.code !== 0 || outcome.signal !== null).toBe(true)

    const survivors = await transport.execInContainer(
      target,
      ['sh', '-c', 'ps -o pid,args | grep "sleep 120" | grep -v grep || true'],
      { timeoutMs: 30_000 },
    )
    expect(survivors.stdout.toString('utf8').trim()).toBe('')
    live.kill()
  })

  it('shares the workspace bytes between host operations and the container', async () => {
    // The fs seam is host-backed now; this is the guarantee the design rests
    // on: the bind mount carries the same bytes in both directions.
    const name = `.dsh-mount-${Date.now()}.txt`
    const hostFile = join(process.cwd(), name)
    await writeFile(hostFile, 'hello from host')
    try {
      const read = await transport.execInContainer(target, ['sh', '-c', `cat /workspace/${name}`], { timeoutMs: 30_000 })
      expect(read.stdout.toString('utf8')).toBe('hello from host')

      const wrote = await transport.execInContainer(
        target,
        ['sh', '-c', `printf 'hello from container' > /workspace/${name}.out`],
        { timeoutMs: 30_000 },
      )
      expect(wrote.code).toBe(0)
      expect(await readFile(`${hostFile}.out`, 'utf8')).toBe('hello from container')
    } finally {
      await rm(hostFile, { force: true })
      await rm(`${hostFile}.out`, { force: true }).catch(() => undefined)
    }
  })

  it('lists the container as owned by this plugin', async () => {
    const owned = await provisioner.listOwned()
    expect(owned.map((container) => container.name)).toContain(target.container)
  })
})
