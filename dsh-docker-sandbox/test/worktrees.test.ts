/**
 * Worktree mode: per-session `git worktree` + branch, the merge-request
 * flow, and the archive sweep's prune rules.
 *
 * The fake CLI runner answers the git calls the manager makes and records
 * every argv it saw, mirroring `fakeTransport`'s fake engine: the assertions
 * are about *which commands* the manager runs, not about real git.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CliCommandError, type CliResult, type CliRunner } from '../src/container/git.ts'
import { PathMapper } from '../src/container/paths.ts'
import { WorktreeManager, compareUrlFor } from '../src/container/worktrees.ts'
import { testConfig } from './helpers.ts'

interface FakeGitOptions {
  /** Answer for `rev-parse --show-toplevel`. */
  repoRoot: string
  /** Fail `rev-parse --show-toplevel` (not a git checkout). */
  notGit?: boolean
  /** `rev-parse --verify refs/heads/…` succeeds (the branch already exists). */
  branchExists?: boolean
  /** Answer for `remote get-url origin`; undefined means "no such remote". */
  remote?: string
  /** Text `status --porcelain` prints ("" means clean). */
  dirty?: string
  /** `merge-base --is-ancestor` succeeds (the branch is merged). */
  merged?: boolean
  /** Answer for `rev-list --count HEAD --not --remotes`. */
  unpushed?: string
  /** Host-effective values answered by `config --get <key>`; unset keys exit 1. */
  gitConfig?: Record<string, string>
  /** Fail every git call with GIT_MISSING (git not on PATH). */
  gitMissing?: boolean
}

interface FakeCli {
  git: CliRunner
  gh: CliRunner
  calls: string[][]
}

function fakeCli(options: FakeGitOptions, ghUrl?: string): FakeCli {
  const calls: string[][] = []
  const ok = (stdout = ''): CliResult => ({ stdout, stderr: '', code: 0 })
  const handle = (args: string[]): CliResult => {
    calls.push(args)
    if (options.gitMissing === true) throw new CliCommandError('git is not available', 'GIT_MISSING')
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
      if (options.notGit === true) throw new CliCommandError('not a git repository', 'GIT_FAILED', 'fatal: not a git repository')
      return ok(`${options.repoRoot}\n`)
    }
    if (args[0] === 'rev-parse' && args[1] === '--verify') {
      if (options.branchExists === true) return ok('deadbeef\n')
      throw new CliCommandError('bad revision', 'GIT_FAILED', '')
    }
    if (args[0] === 'worktree' && args[1] === 'add') {
      // Create the directory the way git would, so later existsSync checks see it.
      const path = args.includes('-B') ? args[4]! : args[2]!
      mkdirSync(path, { recursive: true })
      return ok()
    }
    if (args[0] === 'worktree') return ok() // prune / remove
    if (args[0] === 'branch') return ok() // -D
    if (args[0] === 'status') return ok(options.dirty ?? '')
    if (args[0] === 'rev-list') return ok(`${options.unpushed ?? '0'}\n`)
    if (args[0] === 'remote') {
      if (options.remote === undefined) throw new CliCommandError('no such remote', 'GIT_FAILED', "error: No such remote 'origin'")
      return ok(`${options.remote}\n`)
    }
    if (args[0] === 'merge-base') {
      if (options.merged === true) return ok()
      throw new CliCommandError('not an ancestor', 'GIT_FAILED', '')
    }
    if (args[0] === 'config' && args[1] === '--get') {
      const value = options.gitConfig?.[args[2]!]
      if (value === undefined) throw new CliCommandError('not set', 'GIT_FAILED', '')
      return ok(`${value}\n`)
    }
    return ok() // push / add / commit and friends
  }
  const git: CliRunner = {
    runSync: (args) => handle(args),
    run: async (args) => handle(args),
  }
  const gh: CliRunner = {
    runSync: (args) => {
      calls.push(['gh', ...args])
      return ok()
    },
    run: async (args) => {
      calls.push(['gh', ...args])
      return ok(`${ghUrl ?? 'https://github.com/o/r/pull/7'}\n`)
    },
  }
  return { git, gh, calls }
}

/** A throwaway directory to stand in for a repo root, cleaned after the test. */
function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-wt-'))
  tempRoots.push(dir)
  return dir
}
const tempRoots: string[] = []

afterEach(() => {
  for (const dir of tempRoots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const wtConfig = { worktree: true }

describe('WorktreeManager.ensure', () => {
  it('carves a worktree per session on its own branch', () => {
    const repoRoot = tempRoot()
    const { git, gh, calls } = fakeCli({ repoRoot })
    const manager = new WorktreeManager({ git, gh, config: testConfig(wtConfig), paths: new PathMapper('workspace', '/workspace') })
    const entry = manager.ensure('session-3', repoRoot)
    expect(entry).toBeDefined()
    expect(entry!.branch).toBe('dsh-sbx/session-3')
    expect(entry!.worktreePath).toBe(join(`${repoRoot}.worktrees`, 'session-3'))
    expect(entry!.mainWorkspace).toBe(repoRoot)
    expect(calls).toContainEqual(['rev-parse', '--show-toplevel'])
    expect(calls).toContainEqual(['worktree', 'add', '-B', 'dsh-sbx/session-3', entry!.worktreePath, 'HEAD'])
  })

  it('caches the entry, so later calls never touch git again', () => {
    const repoRoot = tempRoot()
    const { git, gh, calls } = fakeCli({ repoRoot })
    const manager = new WorktreeManager({ git, gh, config: testConfig(wtConfig), paths: new PathMapper('workspace', '/workspace') })
    manager.ensure('session-3', repoRoot)
    const seen = calls.length
    expect(manager.ensure('session-3', repoRoot)).toBeDefined()
    expect(calls.length).toBe(seen)
  })

  it('leaves a non-git workspace on the shared workspace', () => {
    const { git, gh } = fakeCli({ repoRoot: 'F:\\Projects\\plain', notGit: true })
    const manager = new WorktreeManager({ git, gh, config: testConfig(wtConfig), paths: new PathMapper('workspace', '/workspace') })
    expect(manager.ensure('session-3', 'F:\\Projects\\plain')).toBeUndefined()
  })

  it('keeps a git-missing failure sticky and visible, without retrying git', () => {
    const { git, gh, calls } = fakeCli({ repoRoot: 'F:\\Projects\\x', gitMissing: true })
    const manager = new WorktreeManager({ git, gh, config: testConfig(wtConfig), paths: new PathMapper('workspace', '/workspace') })
    expect(manager.ensure('session-3', 'F:\\Projects\\x')).toBeUndefined()
    expect(manager.failureFor('session-3')).toContain('git is not available')
    const seen = calls.length
    manager.ensure('session-3', 'F:\\Projects\\x')
    expect(calls.length).toBe(seen)
  })

  it('does nothing while the toggle is off', () => {
    const { git, gh, calls } = fakeCli({ repoRoot: 'F:\\Projects\\x' })
    const manager = new WorktreeManager({ git, gh, config: testConfig(), paths: new PathMapper('workspace', '/workspace') })
    expect(manager.ensure('session-3', 'F:\\Projects\\x')).toBeUndefined()
    expect(calls.length).toBe(0)
  })

  it('reuses the recorded worktree after a restart, without re-adding it', () => {
    const repoRoot = tempRoot()
    const first = fakeCli({ repoRoot })
    const created = new WorktreeManager({ git: first.git, gh: first.gh, config: testConfig(wtConfig), paths: new PathMapper('workspace', '/workspace') })
      .ensure('session-3', repoRoot)
    expect(created).toBeDefined()
    expect(existsSync(join(`${repoRoot}.worktrees`, 'registry.json'))).toBe(true)

    // A fresh manager (the app restarted): the registry answers the lookup,
    // and no `worktree add` runs for a directory that is still there.
    const second = fakeCli({ repoRoot, branchExists: true })
    const found = new WorktreeManager({ git: second.git, gh: second.gh, config: testConfig(wtConfig), paths: new PathMapper('workspace', '/workspace') })
      .lookup('session-3', repoRoot)
    expect(found?.branch).toBe('dsh-sbx/session-3')
    expect(second.calls.some((call) => call[0] === 'worktree')).toBe(false)
  })

  it('re-attaches a deleted directory on its existing branch, never resetting it', () => {
    const repoRoot = tempRoot()
    const first = fakeCli({ repoRoot })
    const entry = new WorktreeManager({ git: first.git, gh: first.gh, config: testConfig(wtConfig), paths: new PathMapper('workspace', '/workspace') })
      .ensure('session-3', repoRoot)!
    rmSync(entry.worktreePath, { recursive: true, force: true })

    const second = fakeCli({ repoRoot, branchExists: true })
    const manager = new WorktreeManager({ git: second.git, gh: second.gh, config: testConfig(wtConfig), paths: new PathMapper('workspace', '/workspace') })
    manager.ensure('session-3', repoRoot)
    // `add -B` would reset the branch to HEAD and strand the session's
    // commits; the existing branch must be checked out as-is.
    expect(second.calls).toContainEqual(['worktree', 'add', entry.worktreePath, 'dsh-sbx/session-3'])
    expect(second.calls.some((call) => call.includes('-B'))).toBe(false)
  })
})

describe('WorktreeManager.mergeRequest', () => {
  it('commits everything, pushes the branch, and opens a PR through gh', async () => {
    const repoRoot = tempRoot()
    const { git, gh, calls } = fakeCli({ repoRoot, dirty: ' M src/a.ts\n', remote: 'git@github.com:o/r.git' })
    const manager = new WorktreeManager({ git, gh, config: testConfig(wtConfig), paths: new PathMapper('workspace', '/workspace') })
    const result = await manager.mergeRequest('session-3', repoRoot)
    expect(result.committed).toBe(true)
    expect(result.pushed).toBe(true)
    expect(result.prUrl).toBe('https://github.com/o/r/pull/7')
    expect(result.branch).toBe('dsh-sbx/session-3')
    expect(calls).toContainEqual(['add', '-A'])
    expect(calls.some((call) => call[0] === 'commit')).toBe(true)
    expect(calls).toContainEqual(['push', '-u', 'origin', 'dsh-sbx/session-3'])
    expect(calls.some((call) => call[0] === 'gh' && call[1] === 'pr')).toBe(true)
  })

  it('skips the commit when the worktree is already clean', async () => {
    const repoRoot = tempRoot()
    const { git, gh, calls } = fakeCli({ repoRoot, remote: 'git@github.com:o/r.git' })
    const manager = new WorktreeManager({ git, gh, config: testConfig(wtConfig), paths: new PathMapper('workspace', '/workspace') })
    const result = await manager.mergeRequest('session-3', repoRoot)
    expect(result.committed).toBe(false)
    expect(result.pushed).toBe(true)
    expect(calls.some((call) => call[0] === 'commit')).toBe(false)
  })

  it('reports the compare URL when gh is not installed', async () => {
    const repoRoot = tempRoot()
    const { git, calls } = fakeCli({ repoRoot, dirty: ' M a\n', remote: 'https://github.com/o/r.git' })
    const manager = new WorktreeManager({ git, config: testConfig(wtConfig), paths: new PathMapper('workspace', '/workspace') })
    const result = await manager.mergeRequest('session-3', repoRoot)
    expect(result.pushed).toBe(true)
    expect(result.prUrl).toBeUndefined()
    expect(result.compareUrl).toBe('https://github.com/o/r/compare/dsh-sbx/session-3?expand=1')
    expect(calls.some((call) => call[0] === 'gh')).toBe(false)
  })

  it('stops at a commit when the checkout has no remote', async () => {
    const repoRoot = tempRoot()
    const { git, gh } = fakeCli({ repoRoot, dirty: ' M a\n' })
    const manager = new WorktreeManager({ git, gh, config: testConfig(wtConfig), paths: new PathMapper('workspace', '/workspace') })
    const result = await manager.mergeRequest('session-3', repoRoot)
    expect(result.committed).toBe(true)
    expect(result.pushed).toBe(false)
    expect(result.prUrl).toBeUndefined()
  })

  it('refuses a session that has no worktree', async () => {
    const { git, gh } = fakeCli({ repoRoot: 'F:\\Projects\\x', notGit: true })
    const manager = new WorktreeManager({ git, gh, config: testConfig(wtConfig), paths: new PathMapper('workspace', '/workspace') })
    await expect(manager.mergeRequest('session-3', 'F:\\Projects\\x')).rejects.toThrow(/no git worktree/)
  })
})

describe('WorktreeManager.pruneForArchived', () => {
  it('removes an archived worktree that is clean and merged', async () => {
    const repoRoot = tempRoot()
    const { git, gh, calls } = fakeCli({ repoRoot, merged: true })
    const manager = new WorktreeManager({ git, gh, config: testConfig(wtConfig), paths: new PathMapper('workspace', '/workspace') })
    const entry = manager.ensure('session-3', repoRoot)!
    const removed = await manager.pruneForArchived(new Set(['session-3']))
    expect(removed).toEqual([entry.worktreePath])
    expect(calls).toContainEqual(['worktree', 'remove', entry.worktreePath])
    expect(calls).toContainEqual(['branch', '-D', 'dsh-sbx/session-3'])
    // The registry no longer names it.
    const registry = JSON.parse(readFileSync(join(`${repoRoot}.worktrees`, 'registry.json'), 'utf8')) as { entries: Record<string, unknown> }
    expect(registry.entries['session-3']).toBeUndefined()
  })

  it('keeps an archived worktree with uncommitted changes', async () => {
    const repoRoot = tempRoot()
    const { git, gh, calls } = fakeCli({ repoRoot, merged: true, dirty: ' M a\n' })
    const manager = new WorktreeManager({ git, gh, config: testConfig(wtConfig), paths: new PathMapper('workspace', '/workspace') })
    manager.ensure('session-3', repoRoot)
    expect(await manager.pruneForArchived(new Set(['session-3']))).toEqual([])
    expect(calls.some((call) => call[0] === 'worktree' && call[1] === 'remove')).toBe(false)
  })

  it('keeps an archived worktree whose branch was never merged', async () => {
    const repoRoot = tempRoot()
    const { git, gh } = fakeCli({ repoRoot, merged: false })
    const manager = new WorktreeManager({ git, gh, config: testConfig(wtConfig), paths: new PathMapper('workspace', '/workspace') })
    manager.ensure('session-3', repoRoot)
    expect(await manager.pruneForArchived(new Set(['session-3']))).toEqual([])
  })

  it('leaves sessions the archive set does not name alone', async () => {
    const repoRoot = tempRoot()
    const { git, gh } = fakeCli({ repoRoot, merged: true })
    const manager = new WorktreeManager({ git, gh, config: testConfig(wtConfig), paths: new PathMapper('workspace', '/workspace') })
    manager.ensure('session-3', repoRoot)
    expect(await manager.pruneForArchived(new Set(['someone-else']))).toEqual([])
  })
})

describe('compareUrlFor', () => {
  it('knows GitHub over ssh and https', () => {
    expect(compareUrlFor('git@github.com:o/r.git', 'b')).toBe('https://github.com/o/r/compare/b?expand=1')
    expect(compareUrlFor('https://github.com/o/r.git', 'b')).toBe('https://github.com/o/r/compare/b?expand=1')
  })

  it('knows GitLab merge requests', () => {
    expect(compareUrlFor('git@gitlab.com:o/r.git', 'b')).toBe(
      'https://gitlab.com/o/r/-/merge_requests/new?merge_request%5Bsource_branch%5D=b',
    )
  })

  it('names nothing for a remote it does not recognize', () => {
    expect(compareUrlFor('ssh://internal/o/r', 'b')).toBeUndefined()
  })
})

describe('WorktreeManager extra `.git` mount', () => {
  it('registers the main repo .git mount so the container can reach the gitdir', () => {
    const repoRoot = tempRoot()
    const { git, gh } = fakeCli({ repoRoot })
    const paths = new PathMapper('workspace', '/workspace')
    const manager = new WorktreeManager({ git, gh, config: testConfig(wtConfig), paths })
    const entry = manager.ensure('session-3', repoRoot)!
    expect(entry.hostGitDir).toBe(`${repoRoot}/.git/worktrees/session-3`)
    const extra = paths.extraMountFor(entry.worktreePath)
    expect(extra).toBeDefined()
    expect(extra!.mount.hostPath).toBe(`${repoRoot}/.git`)
    expect(extra!.mount.containerPath).toBe(PathMapper.windowsToDrive(`${repoRoot}/.git`))
    expect(extra!.containerGitDir).toBe(PathMapper.windowsToDrive(`${repoRoot}/.git/worktrees/session-3`))
  })

  it('re-registers the mount after a restart, from the registry alone', () => {
    const repoRoot = tempRoot()
    const first = fakeCli({ repoRoot })
    const firstPaths = new PathMapper('workspace', '/workspace')
    const created = new WorktreeManager({ git: first.git, gh: first.gh, config: testConfig(wtConfig), paths: firstPaths })
      .ensure('session-3', repoRoot)!

    const second = fakeCli({ repoRoot, branchExists: true })
    const secondPaths = new PathMapper('workspace', '/workspace')
    const found = new WorktreeManager({ git: second.git, gh: second.gh, config: testConfig(wtConfig), paths: secondPaths })
      .lookup('session-3', repoRoot)!
    expect(found.hostGitDir).toBe(created.hostGitDir)
    expect(secondPaths.extraMountFor(found.worktreePath)).toBeDefined()
  })

  it('mirrors the host git config into the extra mount', () => {
    const repoRoot = tempRoot()
    const { git, gh } = fakeCli({ repoRoot, gitConfig: { 'core.autocrlf': 'true', 'user.name': 'Ada' } })
    const paths = new PathMapper('workspace', '/workspace')
    const entry = new WorktreeManager({ git, gh, config: testConfig(wtConfig), paths }).ensure('session-3', repoRoot)!
    expect(entry.gitConfig).toEqual({ 'core.autocrlf': 'true', 'user.name': 'Ada' })
    expect(paths.extraMountFor(entry.worktreePath)!.gitConfig).toEqual(entry.gitConfig)
  })
})

describe('WorktreeManager subagent aliasing', () => {
  it('points a child session at its parent worktree instead of carving a new one', () => {
    const repoRoot = tempRoot()
    const { git, gh, calls } = fakeCli({ repoRoot })
    const manager = new WorktreeManager({ git, gh, config: testConfig(wtConfig), paths: new PathMapper('workspace', '/workspace') })
    const parent = manager.ensure('session-3', repoRoot)!
    calls.length = 0
    const child = manager.ensure('session-3-child', repoRoot, 'session-3')!
    expect(child.worktreePath).toBe(parent.worktreePath)
    // No `worktree add` ran for the child, and it owns no registry entry.
    expect(calls.some((args) => args[0] === 'worktree' && args[1] === 'add')).toBe(false)
    expect(manager.lookup('session-3-child', repoRoot)).toBeUndefined()
  })

  it('carves its own worktree for a child whose parent has none', () => {
    const repoRoot = tempRoot()
    const { git, gh } = fakeCli({ repoRoot })
    const manager = new WorktreeManager({ git, gh, config: testConfig(wtConfig), paths: new PathMapper('workspace', '/workspace') })
    const child = manager.ensure('session-9-child', repoRoot, 'session-9')!
    expect(child.worktreePath).toContain('session-9-child')
  })
})
