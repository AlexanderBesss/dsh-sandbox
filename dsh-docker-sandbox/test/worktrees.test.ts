import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CliCommandError, type CliResult, type CliRunner } from '../src/container/git.ts'
import { PathMapper } from '../src/container/paths.ts'
import { slugDigest } from '../src/container/session.ts'
import type { WorktreeEntry } from '../src/container/worktrees.ts'
import { WorktreeManager, compareUrlFor } from '../src/container/worktrees.ts'
import { testConfig } from './helpers.ts'

interface FakeGitOptions {
  repoRoot: string
  notGit?: boolean
  branchExists?: boolean
  remote?: string
  dirty?: string
  merged?: boolean
  unpushed?: string
  gitConfig?: Record<string, string>
  gitMissing?: boolean
  mainBranch?: string
  base?: string
  log?: string
  stat?: string
  pushedBranch?: boolean
  fetchFails?: boolean
  originBranch?: string
  behind?: string
  mergeFails?: boolean
  mergeFailsClean?: boolean
  merging?: boolean
  conflicts?: string[]
}

interface FakeCli {
  git: CliRunner
  gh: CliRunner
  calls: string[][]
}

function fakeCli(options: FakeGitOptions, ghUrl?: string, ghFails?: string): FakeCli {
  const calls: string[][] = []
  const ok = (stdout = ''): CliResult => ({ stdout, stderr: '', code: 0 })
  let mergingNow = options.merging === true
  const handle = (args: string[]): CliResult => {
    calls.push(args)
    if (options.gitMissing === true) throw new CliCommandError('git is not available', 'GIT_MISSING')
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
      if (options.notGit === true) throw new CliCommandError('not a git repository', 'GIT_FAILED', 'fatal: not a git repository')
      return ok(`${options.repoRoot}\n`)
    }
    if (args[0] === 'rev-parse' && args[1] === '-q') {
      if (mergingNow) return ok('feedfacefeed\n')
      throw new CliCommandError('no MERGE_HEAD', 'GIT_FAILED', '')
    }
    if (args[0] === 'rev-parse' && args[1] === '--verify') {
      if (options.branchExists === true) return ok('deadbeef\n')
      throw new CliCommandError('bad revision', 'GIT_FAILED', '')
    }
    if (args[0] === 'rev-parse' && args[1] === '--absolute-git-dir') {
      throw new CliCommandError('not a worktree yet', 'GIT_FAILED', '')
    }
    if (args[0] === 'rev-parse') return ok('cafebabe00\n')
    if (args[0] === 'fetch') {
      if (options.fetchFails === true) throw new CliCommandError('fetch failed', 'GIT_FAILED', 'fatal: unable to access origin')
      return ok()
    }
    if (args[0] === 'merge') {
      if (options.mergeFailsClean === true) {
        throw new CliCommandError('merge failed', 'GIT_FAILED', 'error: Your local changes to the following files would be overwritten by merge')
      }
      if (options.mergeFails === true) {
        mergingNow = true
        throw new CliCommandError('merge failed', 'GIT_FAILED', 'CONFLICT (content): Merge conflict')
      }
      return ok()
    }
    if (args[0] === 'worktree' && args[1] === 'add') {
      const path = args.includes('-B') ? args[4]! : args[2]!
      mkdirSync(path, { recursive: true })
      return ok()
    }
    if (args[0] === 'worktree') return ok()
    if (args[0] === 'branch') return ok()
    if (args[0] === 'status') return ok(options.dirty ?? '')
    if (args[0] === 'rev-list') {
      if (args[2]?.includes('..')) return ok(`${options.behind ?? '0'}\n`)
      return ok(`${options.unpushed ?? '0'}\n`)
    }
    if (args[0] === 'remote') {
      if (options.remote === undefined) throw new CliCommandError('no such remote', 'GIT_FAILED', "error: No such remote 'origin'")
      return ok(`${options.remote}\n`)
    }
    if (args[0] === 'merge-base') {
      if (args[1] === '--is-ancestor') {
        if (options.merged === true) return ok()
        throw new CliCommandError('not an ancestor', 'GIT_FAILED', '')
      }
      if (options.base === undefined) throw new CliCommandError('no merge base', 'GIT_FAILED', '')
      return ok(`${options.base}\n`)
    }
    if (args[0] === 'symbolic-ref') return ok(options.mainBranch === undefined ? '' : `${options.mainBranch}\n`)
    if (args[0] === 'log') return ok(`${options.log ?? ''}\n`)
    if (args[0] === 'diff') {
      if (args.includes('--diff-filter=U')) return ok(`${(options.conflicts ?? []).join('\n')}\n`)
      return ok(`${options.stat ?? ''}\n`)
    }
    if (args[0] === 'for-each-ref') {
      if (args[1] === '--quiet') throw new CliCommandError("unknown option `quiet'", 'GIT_FAILED', "error: unknown option `quiet'")
      const pattern = args[args.length - 1]!
      if (options.originBranch !== undefined && pattern === `refs/remotes/origin/${options.originBranch}`) {
        return ok(`${pattern}\n`)
      }
      return ok(options.pushedBranch === true ? `${pattern}\n` : '')
    }
    if (args[0] === 'config' && args[1] === '--get') {
      const value = options.gitConfig?.[args[2]!]
      if (value === undefined) throw new CliCommandError('not set', 'GIT_FAILED', '')
      return ok(`${value}\n`)
    }
    return ok()
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
      if (ghFails !== undefined) throw new CliCommandError('gh pr create failed', 'GH_FAILED', ghFails)
      return ok(`${ghUrl ?? 'https://github.com/o/r/pull/7'}\n`)
    },
  }
  return { git, gh, calls }
}

function createBody(calls: string[][]): string {
  const create = calls.find((call) => call[0] === 'gh' && call[1] === 'pr')!
  return create[create.indexOf('--body') + 1]!
}

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

  it('names the branch after the conversation rather than its id', () => {
    const repoRoot = tempRoot()
    const { git, gh, calls } = fakeCli({ repoRoot })
    const manager = new WorktreeManager({
      git, gh, config: testConfig(wtConfig), paths: new PathMapper('workspace', '/workspace'),
      titleFor: () => 'Fix the login crash!',
    })
    const entry = manager.ensure('session-3', repoRoot)
    const digest = slugDigest('session-3').slice(0, 6)
    expect(entry!.branch).toBe(`dsh-sbx/fix-the-login-crash-${digest}`)
    expect(entry!.worktreePath).toBe(join(`${repoRoot}.worktrees`, `fix-the-login-crash-${digest}`))
    expect(calls).toContainEqual(['worktree', 'add', '-B', entry!.branch, entry!.worktreePath, 'HEAD'])
  })

  it('keeps the session slug when the conversation has no usable name', () => {
    for (const title of [undefined, '', '   ', '🎉 🚀']) {
      const repoRoot = tempRoot()
      const { git, gh } = fakeCli({ repoRoot })
      const manager = new WorktreeManager({
        git, gh, config: testConfig(wtConfig), paths: new PathMapper('workspace', '/workspace'),
        titleFor: () => title,
      })
      expect(manager.ensure('session-3', repoRoot)!.branch).toBe('dsh-sbx/session-3')
    }
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

  it('names the commit, the request, and its description after the conversation', async () => {
    const repoRoot = tempRoot()
    const { git, gh, calls } = fakeCli({
      repoRoot,
      dirty: ' M src/login.ts\n',
      remote: 'git@github.com:o/r.git',
      mainBranch: 'main',
      base: 'deadbeefcafebabedeadbeefcafebabedeadbeef',
      log: 'abc1234 fix the login crash\n5678def cover it with a test',
      stat: ' src/login.ts | 12 ++++++++\n 1 file changed, 12 insertions(+)',
    })
    const manager = new WorktreeManager({
      git, gh, config: testConfig(wtConfig), paths: new PathMapper('workspace', '/workspace'),
      titleFor: () => 'Fix the login crash',
    })
    const result = await manager.mergeRequest('session-3', repoRoot)
    expect(result.prUrl).toBe('https://github.com/o/r/pull/7')
    expect(calls.some((call) => call[0] === 'commit' && call[2] === 'dsh-sbx: Fix the login crash')).toBe(true)
    const create = calls.find((call) => call[0] === 'gh' && call[1] === 'pr')!
    expect(create[create.indexOf('--head') + 1]).toBe(result.branch)
    expect(create[create.indexOf('--title') + 1]).toBe('Fix the login crash')
    const body = create[create.indexOf('--body') + 1]!
    expect(body).toContain('**Fix the login crash**')
    expect(body).toContain('commit `deadbeefcafe`')
    expect(body).toContain('abc1234 fix the login crash')
    expect(body).not.toContain('src/login.ts | 12')
    expect(body).toContain('committed the worktree')
  })

  it('renames the branch to what the change is about, before pushing it', async () => {
    const repoRoot = tempRoot()
    const { git, gh, calls } = fakeCli({
      repoRoot,
      dirty: ' M src/container/worktrees.ts\n',
      remote: 'git@github.com:o/r.git',
      mainBranch: 'main',
      base: 'deadbeefcafebabedeadbeefcafebabedeadbeef',
      log: 'abc1234 name the branch from the content',
      stat: ' src/container/worktrees.ts | 61 +++++',
    })
    const manager = new WorktreeManager({
      git, gh, config: testConfig(wtConfig), paths: new PathMapper('workspace', '/workspace'),
      titleFor: () => 'Also, when we create a branch',
      brief: async () => ({
        brief: {
          branchSlug: 'name-branches-from-content',
          title: 'Name the branch and describe the request from the change',
          bullets: [
            'The merge button names the branch from the staged diff.',
            'A branch already on `origin` keeps its name.',
          ],
        },
      }),
    })
    const result = await manager.mergeRequest('session-3', repoRoot)
    expect(result.renamedFrom).toMatch(/^dsh-sbx\/also-when-we-create-a-branch-[0-9a-f]{6}$/)
    expect(result.branch).toMatch(/^dsh-sbx\/name-branches-from-content-[0-9a-f]{6}$/)
    const renamed = calls.findIndex((call) => call[0] === 'branch' && call[1] === '-m')
    const pushed = calls.findIndex((call) => call[0] === 'push')
    expect(renamed).toBeGreaterThanOrEqual(0)
    expect(calls[renamed]!.slice(0, 3)).toEqual(['branch', '-m', result.renamedFrom])
    expect(calls[renamed]![3]).toBe(result.branch)
    expect(pushed).toBeGreaterThan(renamed)
    expect(calls[pushed]).toEqual(['push', '-u', 'origin', result.branch!])
    expect(calls.some((call) => call[0] === 'commit' && call[2] === 'dsh-sbx: Name the branch and describe the request from the change')).toBe(true)
    const create = calls.find((call) => call[0] === 'gh' && call[1] === 'pr')!
    expect(create[create.indexOf('--head') + 1]).toBe(result.branch)
    expect(create[create.indexOf('--title') + 1]).toBe('Name the branch and describe the request from the change')
    const body = create[create.indexOf('--body') + 1]!
    expect(body).toContain('## Summary\n\n- The merge button names the branch from the staged diff.\n- A branch already on `origin` keeps its name.')
    expect(body).toContain('## Commits (')
  })

  it('stages again after the naming pass, covering the window it opened', async () => {
    const repoRoot = tempRoot()
    const { git, gh, calls } = fakeCli({ repoRoot, dirty: ' M a\n', remote: 'git@github.com:o/r.git' })
    let stagedWhenAsked = 0
    const manager = new WorktreeManager({
      git, gh, config: testConfig(wtConfig), paths: new PathMapper('workspace', '/workspace'),
      brief: async () => {
        stagedWhenAsked = calls.filter((call) => call[0] === 'add').length
        return { brief: { branchSlug: 'a-name', bullets: ['- a change'] } }
      },
    })
    await manager.mergeRequest('session-3', repoRoot)
    expect(stagedWhenAsked).toBe(1)
    expect(calls.filter((call) => call[0] === 'add' && call[1] === '-A')).toHaveLength(2)
  })

  it('keeps a branch that already reached origin, and says why', async () => {
    const repoRoot = tempRoot()
    const { git, gh, calls } = fakeCli({ repoRoot, dirty: ' M a\n', remote: 'git@github.com:o/r.git', pushedBranch: true })
    const brief = async () => ({ brief: { branchSlug: 'a-better-name', bullets: ['- a change'] } })
    const manager = new WorktreeManager({
      git, gh, config: testConfig(wtConfig), paths: new PathMapper('workspace', '/workspace'), brief,
    })
    const result = await manager.mergeRequest('session-3', repoRoot)
    expect(calls.some((call) => call[0] === 'branch' && call[1] === '-m')).toBe(false)
    expect(calls).toContainEqual(['push', '-u', 'origin', 'dsh-sbx/session-3'])
    expect(result.renamedFrom).toBeUndefined()
    expect(result.nameNote).toContain('already been pushed')
    expect(createBody(calls)).toContain('- a change')
  })

  it('keeps the git description when the naming pass cannot answer', async () => {
    const repoRoot = tempRoot()
    const { git, gh, calls } = fakeCli({ repoRoot, dirty: ' M a\n', remote: 'git@github.com:o/r.git' })
    const manager = new WorktreeManager({
      git, gh, config: testConfig(wtConfig), paths: new PathMapper('workspace', '/workspace'),
      brief: async () => ({ error: 'the subagent did not answer within 120000 ms' }),
    })
    const result = await manager.mergeRequest('session-3', repoRoot)
    expect(result.briefError).toContain('did not answer within')
    expect(result.renamedFrom).toBeUndefined()
    expect(result.pushed).toBe(true)
    expect(result.prUrl).toBe('https://github.com/o/r/pull/7')
    expect(createBody(calls)).not.toContain('## Summary')
  })

  it('does not ask for a name when prBrief is off', async () => {
    const repoRoot = tempRoot()
    const { git, gh, calls } = fakeCli({ repoRoot, dirty: ' M a\n', remote: 'git@github.com:o/r.git' })
    let asked = 0
    const manager = new WorktreeManager({
      git, gh, config: testConfig({ ...wtConfig, prBrief: false }), paths: new PathMapper('workspace', '/workspace'),
      brief: async () => {
        asked += 1
        return { brief: { branchSlug: 'a-better-name', bullets: ['- a change'] } }
      },
    })
    const result = await manager.mergeRequest('session-3', repoRoot)
    expect(asked).toBe(0)
    expect(result.branch).toBe('dsh-sbx/session-3')
    expect(calls.some((call) => call[0] === 'branch' && call[1] === '-m')).toBe(false)
  })

  it('describes the branch against HEAD when its fork point is unknown', async () => {
    const repoRoot = tempRoot()
    const { git, gh, calls } = fakeCli({ repoRoot, remote: 'git@github.com:o/r.git', log: 'abc1234 work', stat: ' a.ts | 1 +' })
    const manager = new WorktreeManager({ git, gh, config: testConfig(wtConfig), paths: new PathMapper('workspace', '/workspace') })
    await manager.mergeRequest('session-3', repoRoot)
    const create = calls.find((call) => call[0] === 'gh' && call[1] === 'pr')!
    const body = create[create.indexOf('--body') + 1]!
    expect(body).toContain("the main checkout's `HEAD`")
    expect(body).toContain('abc1234 work')
    expect(create[create.indexOf('--title') + 1]).toBe('dsh-sbx/session-3')
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
    expect(result.prError).toMatch(/GitHub CLI is not configured/)
    expect(calls.some((call) => call[0] === 'gh')).toBe(false)
  })

  it('reports why gh refused, instead of failing silently', async () => {
    const repoRoot = tempRoot()
    const { git, gh } = fakeCli(
      { repoRoot, dirty: ' M a\n', remote: 'https://github.com/o/r.git' },
      undefined,
      'gh: not logged to github.com; run `gh auth login`',
    )
    const manager = new WorktreeManager({ git, gh, config: testConfig(wtConfig), paths: new PathMapper('workspace', '/workspace') })
    const result = await manager.mergeRequest('session-3', repoRoot)
    expect(result.pushed).toBe(true)
    expect(result.prUrl).toBeUndefined()
    expect(result.prError).toMatch(/not logged to github\.com/)
    expect(result.compareUrl).toBe('https://github.com/o/r/compare/dsh-sbx/session-3?expand=1')
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

describe('WorktreeManager sync with main', () => {
  const syncConfig = { ...wtConfig, worktreeSync: true }

  function syncManager(options: FakeGitOptions, extra: { notify?: (sessionId: string, text: string) => boolean; onTreeChanged?: (entry: WorktreeEntry) => void } = {}) {
    const fake = fakeCli(options)
    const manager = new WorktreeManager({
      git: fake.git, gh: fake.gh, config: testConfig(syncConfig),
      paths: new PathMapper('workspace', '/workspace'), ...extra,
    })
    return { fake, manager }
  }

  it('bases a new worktree on origin/main once the fetch lands', () => {
    const repoRoot = tempRoot()
    const { fake, manager } = syncManager({ repoRoot, mainBranch: 'main', originBranch: 'main' })
    const entry = manager.ensure('session-3', repoRoot)!
    expect(fake.calls).toContainEqual(['fetch', 'origin'])
    expect(fake.calls).toContainEqual(['worktree', 'add', '-B', entry.branch, entry.worktreePath, 'origin/main'])
    expect(entry.baseRef).toBe('origin/main')
  })

  it('falls back to the local HEAD when origin cannot be reached', () => {
    const repoRoot = tempRoot()
    const { fake, manager } = syncManager({ repoRoot, mainBranch: 'main', originBranch: 'main', fetchFails: true })
    const entry = manager.ensure('session-3', repoRoot)!
    expect(fake.calls).toContainEqual(['worktree', 'add', '-B', entry.branch, entry.worktreePath, 'HEAD'])
    expect(entry.baseRef).toBeUndefined()
  })

  it('merges main into a clean session branch', async () => {
    const repoRoot = tempRoot()
    const { fake, manager } = syncManager({ repoRoot, mainBranch: 'main', originBranch: 'main', behind: '3' })
    manager.ensure('session-3', repoRoot)
    expect(await manager.syncFor('session-3', repoRoot)).toEqual({ state: 'merged', behind: 3 })
    expect(fake.calls).toContainEqual(['merge', '--no-edit', 'origin/main'])
  })

  it('leaves a conflicted merge to the session agent', async () => {
    const repoRoot = tempRoot()
    const notices: string[] = []
    const { fake, manager } = syncManager(
      { repoRoot, mainBranch: 'main', originBranch: 'main', behind: '2', mergeFails: true, conflicts: ['src/a.ts', 'src/b.ts'] },
      { notify: (_id, text) => { notices.push(text); return true } },
    )
    manager.ensure('session-3', repoRoot)
    const outcome = await manager.syncFor('session-3', repoRoot)
    expect(outcome?.state).toBe('conflict')
    expect(outcome?.conflicts).toEqual(['src/a.ts', 'src/b.ts'])
    expect(fake.calls).toContainEqual(['merge', '--no-edit', 'origin/main'])
    expect(fake.calls).toContainEqual(['diff', '--name-only', '--diff-filter=U'])
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain('src/a.ts')
    expect(notices[0]).toContain('git commit')
  })

  it('reports a merge that failed without conflicting, and tells no one about a conflict', async () => {
    const repoRoot = tempRoot()
    const notices: string[] = []
    const { fake, manager } = syncManager(
      { repoRoot, mainBranch: 'main', originBranch: 'main', behind: '2', mergeFailsClean: true },
      { notify: (_id, text) => { notices.push(text); return true } },
    )
    manager.ensure('session-3', repoRoot)
    expect(await manager.syncFor('session-3', repoRoot)).toEqual({ state: 'failed', behind: 2 })
    expect(fake.calls).toContainEqual(['merge', '--no-edit', 'origin/main'])
    expect(notices).toHaveLength(0)
  })

  it('re-notifies about a mid-merge worktree until the chat received the notice', async () => {
    const repoRoot = tempRoot()
    const notices: string[] = []
    let deliver = false
    const { manager } = syncManager(
      { repoRoot, mainBranch: 'main', originBranch: 'main', merging: true, conflicts: ['src/a.ts'] },
      { notify: (_id, text) => { notices.push(text); return deliver } },
    )
    manager.ensure('session-3', repoRoot)
    expect(await manager.syncFor('session-3', repoRoot)).toEqual({ state: 'conflict' })
    expect(await manager.syncFor('session-3', repoRoot)).toEqual({ state: 'conflict' })
    expect(notices).toHaveLength(2)
    expect(notices[0]).toContain('mid-merge')
    deliver = true
    expect(await manager.syncFor('session-3', repoRoot)).toEqual({ state: 'conflict' })
    expect(notices).toHaveLength(3)
    expect(await manager.syncFor('session-3', repoRoot)).toEqual({ state: 'conflict' })
    expect(notices).toHaveLength(3)
  })

  it('defers while the worktree is dirty, and notifies once per main head', async () => {
    const repoRoot = tempRoot()
    const notices: string[] = []
    const { fake, manager } = syncManager(
      { repoRoot, mainBranch: 'main', originBranch: 'main', behind: '2', dirty: ' M work in progress\n' },
      { notify: (_id, text) => { notices.push(text); return true } },
    )
    manager.ensure('session-3', repoRoot)
    expect(await manager.syncFor('session-3', repoRoot)).toEqual({ state: 'deferred', behind: 2 })
    expect(await manager.syncFor('session-3', repoRoot)).toEqual({ state: 'deferred', behind: 2 })
    expect(fake.calls.some((call) => call[0] === 'merge')).toBe(false)
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain('uncommitted changes')
  })

  it('throttles fetches, so repeated syncs reuse the last one', async () => {
    const repoRoot = tempRoot()
    const { fake, manager } = syncManager({ repoRoot, mainBranch: 'main', originBranch: 'main' })
    manager.ensure('session-3', repoRoot)
    await manager.syncFor('session-3', repoRoot)
    await manager.syncFor('session-3', repoRoot)
    expect(fake.calls.filter((call) => call[0] === 'fetch')).toHaveLength(1)
  })

  it('syncLive skips archived and busy sessions and merges the rest', async () => {
    const repoRoot = tempRoot()
    const { fake, manager } = syncManager({ repoRoot, mainBranch: 'main', originBranch: 'main', behind: '1' })
    manager.ensure('session-3', repoRoot)
    expect(await manager.syncLive(new Set(['session-3']), () => true)).toEqual([])
    expect(await manager.syncLive(new Set(), () => false)).toEqual([])
    expect(fake.calls.some((call) => call[0] === 'merge')).toBe(false)
    expect(await manager.syncLive(new Set(), () => true)).toEqual([{ state: 'merged', behind: 1 }])
  })

  it('refuses the merge button while the worktree is mid-merge', async () => {
    const repoRoot = tempRoot()
    const { manager } = syncManager({ repoRoot, merging: true })
    await expect(manager.mergeRequest('session-3', repoRoot)).rejects.toThrow(/mid-merge with main/)
  })

  it('reinstalls when a merged lockfile differs from the installed one', async () => {
    const repoRoot = tempRoot()
    const changed: string[] = []
    const { manager } = syncManager(
      { repoRoot, mainBranch: 'main', originBranch: 'main', behind: '1' },
      { onTreeChanged: (entry) => changed.push(entry.sessionId) },
    )
    const entry = manager.ensure('session-3', repoRoot)!
    writeFileSync(join(entry.worktreePath, 'package-lock.json'), '{"lockfileVersion":3}')
    manager.markInstalled('session-3', repoRoot)
    writeFileSync(join(entry.worktreePath, 'package-lock.json'), '{"lockfileVersion":3,"changed":true}')
    expect(await manager.syncFor('session-3', repoRoot)).toEqual({ state: 'merged', behind: 1 })
    expect(changed).toEqual(['session-3'])
  })

  it('retries the reinstall on later syncs while the install never succeeded', async () => {
    const repoRoot = tempRoot()
    const changed: string[] = []
    const { manager } = syncManager(
      { repoRoot, mainBranch: 'main', originBranch: 'main', behind: '1' },
      { onTreeChanged: (entry) => changed.push(entry.sessionId) },
    )
    const entry = manager.ensure('session-3', repoRoot)!
    writeFileSync(join(entry.worktreePath, 'package-lock.json'), '{"lockfileVersion":3}')
    manager.markInstalled('session-3', repoRoot)
    writeFileSync(join(entry.worktreePath, 'package-lock.json'), '{"lockfileVersion":3,"changed":true}')
    expect(await manager.syncFor('session-3', repoRoot)).toEqual({ state: 'merged', behind: 1 })
    expect(await manager.syncFor('session-3', repoRoot)).toEqual({ state: 'merged', behind: 1 })
    expect(changed).toEqual(['session-3', 'session-3'])
    manager.markInstalled('session-3', repoRoot)
    expect(await manager.syncFor('session-3', repoRoot)).toEqual({ state: 'merged', behind: 1 })
    expect(changed).toHaveLength(2)
  })

  it('is inert while worktreeSync is off', async () => {
    const repoRoot = tempRoot()
    const fake = fakeCli({ repoRoot, mainBranch: 'main', originBranch: 'main', behind: '5' })
    const manager = new WorktreeManager({
      git: fake.git, gh: fake.gh, config: testConfig({ ...wtConfig, worktreeSync: false }),
      paths: new PathMapper('workspace', '/workspace'),
    })
    manager.ensure('session-3', repoRoot)
    expect(await manager.syncFor('session-3', repoRoot)).toBeUndefined()
    expect(fake.calls.some((call) => call[0] === 'fetch')).toBe(false)
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
    expect(extra!.aliasHost).toBe(repoRoot)
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
