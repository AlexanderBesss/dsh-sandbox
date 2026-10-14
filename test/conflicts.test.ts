import { describe, expect, it } from 'vitest'
import { CliCommandError, type CliResult, type CliRunner } from '../src/container/git.ts'
import {
  MAX_CONFLICT_DIFF_CHARS,
  MAX_DIFF_PATHS,
  buildConflictPrompt,
  collectConflicts,
  conflictedFiles,
} from '../src/container/conflicts.ts'
import type { WorktreeEntry } from '../src/container/worktrees.ts'

interface FakeGitOptions {
  mergeHead?: string
  conflicts?: string[]
  subject?: string
  status?: string
  diff?: string
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
      if (args[0] === 'rev-parse') {
        if (options.mergeHead === undefined) throw new CliCommandError('no MERGE_HEAD', 'GIT_FAILED', '')
        return ok(`${options.mergeHead}\n`)
      }
      if (args[0] === 'log') return ok(`${options.subject ?? ''}\n`)
      if (args[0] === 'status') return ok(options.status ?? '')
      if (args[0] === 'diff' && args.includes('--diff-filter=U')) return ok((options.conflicts ?? []).join('\0'))
      if (args[0] === 'diff') return ok(options.diff ?? '')
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

describe('collectConflicts', () => {
  it('names what is being merged and which files it stopped on', async () => {
    const { git } = fakeGit({
      mergeHead: 'feedfacefeedfeedfacefeedfeedfacefeedfacefeed',
      subject: 'refuse the turn when the engine is down',
      conflicts: ['src/a.ts', 'src/b.ts'],
      status: 'UU src/a.ts\nUU src/b.ts',
      diff: 'diff --git a/src/a.ts b/src/a.ts\n',
    })
    expect(await collectConflicts(git, entry)).toEqual({
      merging: true,
      conflicts: ['src/a.ts', 'src/b.ts'],
      mergingRef: 'feedfacefeed',
      mergingSubject: 'refuse the turn when the engine is down',
      status: 'UU src/a.ts\nUU src/b.ts',
      diff: 'diff --git a/src/a.ts b/src/a.ts\n',
      truncated: false,
      diffPathsTruncated: false,
    })
  })

  it('reports no merge when there is no MERGE_HEAD, and never collects a diff for it', async () => {
    const { git, calls } = fakeGit({ conflicts: [] })
    expect(await collectConflicts(git, entry)).toEqual({
      merging: false,
      conflicts: [],
      status: '',
      diff: '',
      truncated: false,
      diffPathsTruncated: false,
    })
    expect(calls.some((args) => args[0] === 'diff' && args[1] === '--')).toBe(false)
  })

  it('clips an oversized conflict diff and says so', async () => {
    const { git } = fakeGit({
      mergeHead: 'feedfacefeed',
      conflicts: ['src/a.ts'],
      diff: 'x'.repeat(MAX_CONFLICT_DIFF_CHARS + 500),
    })
    const facts = await collectConflicts(git, entry)
    expect(facts.diff).toHaveLength(MAX_CONFLICT_DIFF_CHARS)
    expect(facts.truncated).toBe(true)
    expect(facts.diffPathsTruncated).toBe(false)
  })

  it('asks for the diff of a bounded prefix, and flags that the rest is missing', async () => {
    const many = Array.from({ length: MAX_DIFF_PATHS + 20 }, (_unused, index) => `src/file-${index}.ts`)
    const { git, calls } = fakeGit({ mergeHead: 'feedfacefeed', conflicts: many })
    const facts = await collectConflicts(git, entry)
    expect(facts.conflicts).toHaveLength(MAX_DIFF_PATHS + 20)
    expect(facts.diffPathsTruncated).toBe(true)
    const diffCall = calls.find((args) => args[1] === '--')!
    expect(diffCall).toHaveLength(MAX_DIFF_PATHS + 2)
    expect(diffCall).toContain(`:(literal)src/file-${MAX_DIFF_PATHS - 1}.ts`)
    expect(diffCall).not.toContain(`:(literal)src/file-${MAX_DIFF_PATHS}.ts`)
  })

  it('asks git not to read glob magic in a conflicted path', async () => {
    const { git, calls } = fakeGit({ mergeHead: 'feedfacefeed', conflicts: ['src/a[1]*b.ts'] })
    await collectConflicts(git, entry)
    expect(calls.find((args) => args[1] === '--')).toEqual(['diff', '--', ':(literal)src/a[1]*b.ts'])
  })
})

describe('conflictedFiles', () => {
  it('reads the unmerged paths byte-exact, including names git would quote', async () => {
    const { git, calls } = fakeGit({ mergeHead: 'feedfacefeed', conflicts: ['src/a.ts', 'src/файл (1).ts'] })
    expect(await conflictedFiles(git, entry)).toEqual(['src/a.ts', 'src/файл (1).ts'])
    expect(calls).toContainEqual(['diff', '-z', '--name-only', '--diff-filter=U'])
  })

  it('answers with nothing when git cannot be asked', async () => {
    const git: CliRunner = {
      runSync: () => ({ stdout: '', stderr: '', code: 0 }),
      run: async () => { throw new CliCommandError('git is not available', 'GIT_MISSING') },
    }
    expect(await conflictedFiles(git, entry)).toEqual([])
  })
})

describe('buildConflictPrompt', () => {
  it('maps the two sides and forbids backing the merge out', async () => {
    const { git } = fakeGit({
      mergeHead: 'feedfacefeed',
      subject: 'refuse the turn when the engine is down',
      conflicts: ['src/a.ts'],
      status: 'UU src/a.ts',
      diff: '<<<<<<< HEAD',
    })
    const prompt = buildConflictPrompt(entry, await collectConflicts(git, entry))
    expect(prompt).toContain('branch dsh-sbx/session-3')
    expect(prompt).toContain('MERGE_HEAD (feedfacefeed, "refuse the turn when the engine is down")')
    expect(prompt).toContain('- src/a.ts')
    expect(prompt).toContain('`git show :1:<file>` is the common ancestor')
    expect(prompt).toContain('git commit --no-edit')
    expect(prompt).toContain('Do not `git merge --abort`')
    expect(prompt).toContain('MERGE COMMITTED <sha>')
    expect(prompt).not.toContain('A sync merged')
  })

  it('says the merge commit is all that is pending once the markers are gone', async () => {
    const { git } = fakeGit({ mergeHead: 'feedfacefeed', conflicts: [] })
    const prompt = buildConflictPrompt(entry, await collectConflicts(git, entry))
    expect(prompt).toContain('only the merge commit is pending')
    expect(prompt).toContain('(empty — run `git diff` for it)')
  })

  it('admits when the diff covers only part of the conflicted files', async () => {
    const many = Array.from({ length: MAX_DIFF_PATHS + 20 }, (_unused, index) => `src/file-${index}.ts`)
    const { git } = fakeGit({ mergeHead: 'feedfacefeed', conflicts: many, diff: 'diff --git a/x b/x' })
    const prompt = buildConflictPrompt(entry, await collectConflicts(git, entry))
    expect(prompt).toContain(`CONFLICTED FILES (git diff, covering the first ${MAX_DIFF_PATHS} of ${many.length} files):`)
  })

  it('says when the diff itself was clipped', async () => {
    const { git } = fakeGit({
      mergeHead: 'feedfacefeed',
      conflicts: ['src/a.ts'],
      diff: 'x'.repeat(MAX_CONFLICT_DIFF_CHARS + 10),
    })
    const prompt = buildConflictPrompt(entry, await collectConflicts(git, entry))
    expect(prompt).toContain(`CONFLICTED FILES (git diff, truncated to ${MAX_CONFLICT_DIFF_CHARS} chars):`)
  })
})
