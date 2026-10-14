import { describe, expect, it } from 'vitest'
import { CliCommandError, createCliRunner } from '../src/container/git.ts'

describe('createCliRunner.run', () => {
  it('resolves with the output of a successful call', async () => {
    const runner = createCliRunner([process.execPath, '-e'], 'git')
    const out = await runner.run(['process.stdout.write("hi")'])
    expect(out.stdout).toBe('hi')
    expect(out.code).toBe(0)
  })

  it('rejects (not throws) when the child exits non-zero', async () => {
    // `merge-base --is-ancestor` answers 1 for "not merged": must reject; a throw crashed the app host
    const runner = createCliRunner([process.execPath, '-e'], 'git')
    await expect(runner.run(['process.exit(3)'])).rejects.toThrow(CliCommandError)
  })

  it('rejects with GIT_MISSING when the binary is absent', async () => {
    const runner = createCliRunner(['definitely-not-a-command-xyz'], 'git')
    const error = await runner.run(['status']).catch((e: unknown) => e as CliCommandError)
    expect(error).toBeInstanceOf(CliCommandError)
    expect(error.code).toBe('GIT_MISSING')
  })
})
