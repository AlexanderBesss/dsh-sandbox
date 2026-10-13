/**
 * The in-container command runner.
 *
 * The signaler in `subprocess.ts` depends on the exact pidfile path the runner
 * writes, and on the setsid branch making the recorded pid the process group
 * id. These checks pin that contract from the script text; the live behaviour
 * is covered by `test/integration/docker.test.ts`.
 */

import { readFile } from 'node:fs/promises'
import { beforeAll, describe, expect, it } from 'vitest'

let script = ''

beforeAll(async () => {
  // Normalise like `uploadAgents` does, so a CRLF checkout cannot skew the
  // line-oriented checks below.
  script = (await readFile(new URL('../agent/run.sh', import.meta.url), 'utf8')).replace(/\r\n/g, '\n')
})

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
