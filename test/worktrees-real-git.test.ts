import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createCliRunner } from '../src/container/git.ts'
import { PathMapper } from '../src/container/paths.ts'
import type { PullRequestFacts } from '../src/container/pr-description.ts'
import { WorktreeManager } from '../src/container/worktrees.ts'
import { testConfig } from './helpers.ts'

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const roots: string[] = []
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd }).toString().trimEnd()

function seededRepo(): { origin: string; repo: string } {
  const base = mkdtempSync(join(tmpdir(), 'dsh-real-git-'))
  roots.push(base)
  const origin = join(base, 'origin.git')
  const repo = join(base, 'repo')
  git(base, 'init', '--bare', '-b', 'main', origin)
  git(base, 'init', '-b', 'main', repo)
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Test')
  writeFileSync(join(repo, 'README.md'), '# fixture\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-m', 'seed')
  git(repo, 'remote', 'add', 'origin', origin)
  git(repo, 'push', '-u', 'origin', 'main')
  return { origin, repo }
}

const ghAnswering = (url: string, calls?: string[][]) => ({
  runSync: () => ({ stdout: '', stderr: '', code: 0 }),
  run: async (args: string[]) => {
    calls?.push(args)
    return { stdout: `${url}\n`, stderr: '', code: 0 }
  },
})

describe.skipIf(!hasGit)('WorktreeManager.mergeRequest against real git', () => {
  it('renames the branch before pushing it, and describes the change', async () => {
    const { origin, repo } = seededRepo()

    const ghCalls: string[][] = []
    const manager = new WorktreeManager({
      git: createCliRunner(['git'], 'git'),
      gh: ghAnswering('https://github.com/o/r/pull/1', ghCalls),
      config: testConfig({ worktree: true }),
      paths: new PathMapper('workspace', '/workspace'),
      titleFor: () => 'Also, when we create a branch',
      brief: async () => ({
        brief: {
          branchSlug: 'refuse-turn-when-engine-down',
          title: 'Refuse the turn when the engine is down',
          bullets: [
            'Worktree mode fails the turn with a visible error when Docker is unreachable.',
            'The reason reaches the chat instead of the tool call falling back silently.',
          ],
        },
      }),
    })

    const entry = manager.ensure('session-3', repo)
    expect(entry).toBeDefined()
    const created = entry!.branch
    writeFileSync(join(entry!.worktreePath, 'gate.ts'), 'export const gate = 1\n')

    const result = await manager.mergeRequest('session-3', repo)
    const create = ghCalls.find((args) => args[0] === 'pr')!
    const body = create[create.indexOf('--body') + 1]!

    expect(result.renamedFrom).toBe(created)
    expect(result.branch).toMatch(/^dsh-sbx\/refuse-turn-when-engine-down-[0-9a-f]{6}$/)
    expect(git(repo, 'branch', '--format=%(refname:short)')).not.toContain(created)
    expect(git(origin, 'branch')).toContain(result.branch!)
    expect(git(origin, 'branch')).not.toContain(created)
    expect(git(result.worktreePath, 'branch', '--show-current')).toBe(result.branch)
    expect(git(repo, 'worktree', 'list')).toContain(entry!.worktreePath.replace(/\\/g, '/'))

    expect(create[create.indexOf('--head') + 1]).toBe(result.branch)
    expect(create[create.indexOf('--title') + 1]).toBe('Refuse the turn when the engine is down')
    expect(git(result.worktreePath, 'log', '--format=%s', '-1')).toBe('dsh-sbx: Refuse the turn when the engine is down')
    expect(body).toContain('## Summary\n\n- Worktree mode fails the turn')
    expect(body).toContain('## Commits (1)')
    expect(body).toContain('dsh-sbx: Refuse the turn when the engine is down')
    expect(body).not.toContain('Files changed')
    expect(body).not.toContain('gate.ts | 1 +')
  })

  it('keeps the branch name a second click would otherwise re-propose', async () => {
    const { origin, repo } = seededRepo()

    let click = 0
    const manager = new WorktreeManager({
      git: createCliRunner(['git'], 'git'),
      gh: ghAnswering('https://github.com/o/r/pull/2'),
      config: testConfig({ worktree: true }),
      paths: new PathMapper('workspace', '/workspace'),
      brief: async () => ({
        brief: { branchSlug: click++ === 0 ? 'a-name-chosen-first' : 'a-name-chosen-later', bullets: ['- a change'] },
      }),
    })

    const first = await manager.mergeRequest('session-3', repo)
    expect(first.renamedFrom).toBeDefined()
    writeFileSync(join(first.worktreePath, 'more.ts'), 'export const more = 1\n')
    const second = await manager.mergeRequest('session-3', repo)
    expect(second.branch).toBe(first.branch)
    expect(second.renamedFrom).toBeUndefined()
    expect(second.nameNote).toContain('already been pushed')
    expect(git(origin, 'branch')).toContain(first.branch!)
  })

  it('commits what the naming pass itself wrote into the worktree', async () => {
    const { repo } = seededRepo()

    const brief = async (_sessionId: string, facts: PullRequestFacts) => {
      writeFileSync(join(facts.worktreePath, 'late.ts'), 'export const late = 1\n')
      return { brief: { bullets: ['- a change'] } }
    }
    const manager = new WorktreeManager({
      git: createCliRunner(['git'], 'git'),
      gh: ghAnswering('https://github.com/o/r/pull/3'),
      config: testConfig({ worktree: true }),
      paths: new PathMapper('workspace', '/workspace'),
      brief,
    })

    const entry = manager.ensure('session-3', repo)!
    writeFileSync(join(entry.worktreePath, 'gate.ts'), 'export const gate = 1\n')
    const result = await manager.mergeRequest('session-3', repo)

    expect(result.committed).toBe(true)
    const files = git(result.worktreePath, 'show', '--name-only', '--format=', 'HEAD')
      .split(/\r?\n/)
      .map((name) => name.trim())
    expect(files).toContain('gate.ts')
    expect(files).toContain('late.ts')
  })
})
