import { readFile } from 'node:fs/promises'
import { beforeAll, describe, expect, it } from 'vitest'

let script = ''

beforeAll(async () => {
  // normalise like `uploadAgents` does, so a CRLF checkout cannot skew the line checks
  script = (await readFile(new URL('../agent/run.sh', import.meta.url), 'utf8')).replace(/\r\n/g, '\n')
})

// the signaler in subprocess.ts depends on the exact pidfile path and the setsid process group
describe('agent/run.sh', () => {
  it('records the pid under the path the signaler reads', () => {
    expect(script).toContain('pidfile=/tmp/.dsh-pid-$op')
    expect(script).toContain('echo "$$" > "$1"')
  })

  it('prefers setsid so the recorded pid leads its own process group', () => {
    const setsidBranch = script.indexOf('setsid sh -c')
    const fallbackBranch = script.indexOf('else\n  sh -c')
    expect(setsidBranch).toBeGreaterThan(-1)
    expect(fallbackBranch).toBeGreaterThan(setsidBranch)
  })

  it('refuses a missing cwd with a distinct exit code', () => {
    expect(script).toContain('exit 64')
  })
})
