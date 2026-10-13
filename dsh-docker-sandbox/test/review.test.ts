/**
 * Session review: the collected changes and the reviewer's prompt.
 *
 * The fake CLI runner answers the git calls `collectChanges` makes, so the
 * assertions cover which diff the reviewer would see (fork-point diff,
 * fallbacks when the main checkout is detached, truncation) without real git.
 */

import { describe, expect, it } from 'vitest'
import type { CliResult, CliRunner } from '../src/container/git.ts'
import { CliCommandError } from '../src/container/git.ts'
import { MAX_DIFF_CHARS, buildReviewPrompt, changesAreEmpty, collectChanges } from '../src/container/review.ts'
import type { WorktreeEntry } from '../src/container/worktrees.ts'

interface FakeGitOptions {
  /** Answer for `symbolic-ref --short HEAD` in the main checkout (undefined = detached). */
  mainBranch?: string
  /** Answer for `merge-base HEAD <branch>` (undefined = fails). */
  mergeBase?: string
  /** Text `diff <base>` prints. */
  diff?: string
  /** Text `log --oneline` prints. */
  log?: string
  /** Text `status --porcelain` prints. */
  status?: string
}

function fakeGit(options: FakeGitOptions): { git: CliRunner; calls: string[][] } {
  const calls: string[][] = []
  const ok = (stdout = ''): CliResult => ({ stdout, stderr: '', code: 0 })
  const git: CliRunner = {
    runSync: (args) => {
      calls.push(args)
      return ok()
    },
    run: async (args) => {
      calls.push(args)
      if (args[0] === 'symbolic-ref') {
        if (options.mainBranch === undefined) throw new CliCommandError('detached', 'GIT_FAILED', '')
        return ok(`${options.mainBranch}\n`)
      }
      if (args[0] === 'merge-base') {
        if (options.mergeBase === undefined) throw new CliCommandError('no merge base', 'GIT_FAILED', '')
        return ok(`${options.mergeBase}\n`)
      }
      if (args[0] === 'diff') return ok(options.diff ?? '')
      if (args[0] === 'log') return ok(options.log ?? '')
      if (args[0] === 'status') return ok(options.status ?? '')
      return ok()
    },
  }
  return { git, calls }
}

const entry: WorktreeEntry = {
  sessionId: 'session-3',
  mainWorkspace: 'F:\\Projects\\app',
  repoRoot: 'F:/Projects/app',
  worktreePath: 'F:\\Projects\\app.worktrees\\session-3',
  branch: 'dsh-sbx/session-3',
  createdAt: 0,
  hostGitDir: 'F:/Projects/app/.git/worktrees/session-3',
  gitConfig: {},
}

describe('collectChanges', () => {
  it('diffs against the fork point when the main checkout has a branch', async () => {
    const { git, calls } = fakeGit({
      mainBranch: 'main',
      mergeBase: 'abcdef1234567890',
      diff: 'diff --git a/x b/x\n',
      log: '1111111 session work\n',
      status: ' M src/x.ts\n',
    })
    const changes = await collectChanges(git, entry)
    expect(changes.base).toBe('abcdef123456')
    expect(changes.diff).toContain('diff --git')
    expect(changes.log).toBe('1111111 session work')
    expect(changes.status).toBe('M src/x.ts')
    expect(changes.truncated).toBe(false)
    expect(calls).toContainEqual(['diff', 'abcdef1234567890'])
    expect(calls).toContainEqual(['log', '--oneline', 'abcdef1234567890..HEAD'])
  })

  it('falls back to HEAD and unpushed commits when the main checkout is detached', async () => {
    const { git, calls } = fakeGit({ diff: 'd', log: 'l', status: 's' })
    const changes = await collectChanges(git, entry)
    expect(changes.base).toBeUndefined()
    expect(calls).toContainEqual(['diff', 'HEAD'])
    expect(calls).toContainEqual(['log', '--oneline', 'HEAD', '--not', '--remotes'])
  })

  it('truncates an oversized diff and says so', async () => {
    const { git } = fakeGit({ mainBranch: 'main', mergeBase: 'abc', diff: 'x'.repeat(MAX_DIFF_CHARS + 10) })
    const changes = await collectChanges(git, entry)
    expect(changes.truncated).toBe(true)
    expect(changes.diff).toHaveLength(MAX_DIFF_CHARS)
  })

  it('reports empty changes when the worktree matches its fork point', async () => {
    const { git } = fakeGit({ mainBranch: 'main', mergeBase: 'abc' })
    const changes = await collectChanges(git, entry)
    expect(changesAreEmpty(changes)).toBe(true)
  })
})

describe('buildReviewPrompt', () => {
  it('carries the worktree, branch, diff, and the clean-slate instruction', async () => {
    const { git } = fakeGit({
      mainBranch: 'main',
      mergeBase: 'abcdef1234567890',
      diff: 'diff --git a/x b/x\n+hello\n',
      status: ' M src/x.ts',
    })
    const changes = await collectChanges(git, entry)
    const prompt = buildReviewPrompt(entry, changes)
    expect(prompt).toContain('no memory of the conversation')
    expect(prompt).toContain('dsh-sbx/session-3')
    expect(prompt).toContain('F:\\Projects\\app.worktrees\\session-3')
    expect(prompt).toContain('+hello')
    expect(prompt).toContain('M src/x.ts')
    expect(prompt).toContain('Do not modify anything')
  })

  it('marks a truncated diff in the prompt', async () => {
    const { git } = fakeGit({ mainBranch: 'main', mergeBase: 'abc', diff: 'y'.repeat(MAX_DIFF_CHARS + 1) })
    const changes = await collectChanges(git, entry)
    expect(buildReviewPrompt(entry, changes)).toContain(`truncated to ${MAX_DIFF_CHARS} chars`)
  })
})
