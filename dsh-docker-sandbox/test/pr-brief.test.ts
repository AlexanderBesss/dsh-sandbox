import { describe, expect, it } from 'vitest'
import {
  BRIEF_DIFF_CHARS,
  MAX_BRIEF_BULLETS,
  buildBriefPrompt,
  createPrBrief,
  parseBrief,
} from '../src/container/pr-brief.ts'
import type { PullRequestFacts } from '../src/container/pr-description.ts'
import type { CliRunner } from '../src/container/git.ts'
import type { SubagentResult, SubagentService } from '../src/context.ts'
import { testConfig } from './helpers.ts'

function facts(overrides: Partial<PullRequestFacts> = {}): PullRequestFacts {
  return {
    sessionId: 'session-3',
    branch: 'dsh-sbx/also-when-we-create-a-branch-1a2b3c',
    worktreePath: 'F:\\Projects\\repo.worktrees\\also-when-we-create-a-branch-1a2b3c',
    mainWorkspace: 'F:\\Projects\\repo',
    container: 'dsh-sbx-session-3',
    base: 'deadbeefcafe',
    log: 'abc1234 name the branch from the content',
    stat: ' src/container/worktrees.ts | 40 +++++++',
    committed: true,
    title: 'Also, when we create a branch',
    ...overrides,
  }
}

const fakeGit = (diff = 'diff --git a/x b/x\n+x'): CliRunner => ({
  runSync: () => ({ stdout: '', stderr: '', code: 0 }),
  run: async (args) => ({ stdout: args[0] === 'diff' ? diff : '', stderr: '', code: 0 }),
})

interface Answer {
  text?: string
  stopReason?: string
  never?: boolean
  startThrows?: string
  startLate?: number
}

function fakeSubagents(answer: Answer) {
  const started: Array<{ prompt: string; label?: string; signal: AbortSignal }> = []
  let disposed = 0
  const service: SubagentService = {
    list: () => ['default'],
    start: async (_provider, request) => {
      if (answer.startThrows !== undefined) throw new Error(answer.startThrows)
      if (answer.startLate !== undefined) await new Promise((resolve) => setTimeout(resolve, answer.startLate))
      started.push({ prompt: request.prompt[0]?.text ?? '', label: request.label, signal: request.signal })
      const result: Promise<SubagentResult> = answer.never === true
        ? new Promise<SubagentResult>(() => undefined)
        : Promise.resolve({
            stopReason: answer.stopReason ?? 'completed',
            output: [{ type: 'text', text: answer.text ?? '' }],
          })
      return {
        localAgent: { session: { id: 'child-1' } },
        result,
        dispose: () => {
          disposed += 1
        },
      }
    },
  }
  return { service, started, disposed: () => disposed }
}

function wiring(answer: Answer, configOverrides: Parameters<typeof testConfig>[0] = {}) {
  const sub = fakeSubagents(answer)
  return {
    ...sub,
    deps: {
      subagents: () => sub.service,
      parentFor: (sessionId: string) => ({ id: sessionId }),
      git: fakeGit(),
      config: testConfig(configOverrides),
    },
  }
}

const GOOD_ANSWER = [
  'BRANCH: name-branches-from-content',
  'TITLE: Name the branch and describe the request from the change itself',
  '- The merge button now names the branch from the committed diff, so `git branch` reads as the change.',
  '- The pull-request body gains bullet points written by a fresh subagent.',
  '- No tests were added for the prompt text itself.',
].join('\n')

describe('parseBrief', () => {
  it('reads the branch, the title, and the bullets', () => {
    expect(parseBrief(GOOD_ANSWER)).toEqual({
      branchSlug: 'name-branches-from-content',
      title: 'Name the branch and describe the request from the change itself',
      bullets: [
        'The merge button now names the branch from the committed diff, so `git branch` reads as the change.',
        'The pull-request body gains bullet points written by a fresh subagent.',
        'No tests were added for the prompt text itself.',
      ],
    })
  })

  it('drops the preamble, the fence, and the closing paragraph', () => {
    const answer = [
      'Here is the summary you asked for:',
      '```',
      'BRANCH: fix-login-crash',
      '- first change',
      '```',
      'Let me know if you want it shorter.',
    ].join('\n')
    expect(parseBrief(answer)).toEqual({ branchSlug: 'fix-login-crash', bullets: ['first change'] })
  })

  it('refuses to read a diff line as a bullet', () => {
    const answer = ['BRANCH: fix-login-crash', '- -old code line', '- --- a/src/x.ts', '- real change'].join('\n')
    expect(parseBrief(answer)?.bullets).toEqual(['real change'])
  })

  it('keeps the bullets when the name or title is unusable', () => {
    const brief = parseBrief('BRANCH: session 3\n- real change')
    expect(brief?.bullets).toEqual(['real change'])
    expect(brief?.branchSlug).toBe('session-3')
    expect(parseBrief('- only a bullet')?.title).toBeUndefined()
  })

  it('treats an answer without bullets as no answer', () => {
    expect(parseBrief('BRANCH: fix-login-crash\nTITLE: Fix the login crash')).toBeUndefined()
    expect(parseBrief('')).toBeUndefined()
  })

  it('caps how much it takes from an endless answer', () => {
    const answer = ['BRANCH: fix-crash', ...Array.from({ length: 40 }, (_unused, i) => `- bullet ${i}`)].join('\n')
    const brief = parseBrief(answer)
    expect(brief?.bullets).toHaveLength(MAX_BRIEF_BULLETS)
  })

  it('cuts an overlong bullet at a word boundary', () => {
    const long = 'word '.repeat(80)
    const brief = parseBrief(`- ${long.trim()}`)
    expect(brief?.bullets[0]?.length).toBeLessThanOrEqual(201)
    expect(brief?.bullets[0]).toMatch(/…$/)
  })
})

describe('buildBriefPrompt', () => {
  it('puts the change in front of the child', () => {
    const prompt = buildBriefPrompt(facts(), 'diff --git a/x b/x\n+x')
    expect(prompt).toContain('dsh-sbx/also-when-we-create-a-branch-1a2b3c')
    expect(prompt).toContain('commit `deadbeefcafe`')
    expect(prompt).toContain('abc1234 name the branch from the content')
    expect(prompt).toContain('src/container/worktrees.ts | 40')
    expect(prompt).toContain('diff --git a/x b/x')
  })

  it('spells out the shape the parser expects, and the rules that make it useful', () => {
    const prompt = buildBriefPrompt(facts(), '')
    expect(prompt).toContain('BRANCH: <3 to 5 words, kebab-case')
    expect(prompt).toContain('TITLE: <one line under 80 characters')
    expect(prompt).toContain('Cover every independent change in the diff')
    expect(prompt).toContain('Write nothing you cannot point at in the diff')
    expect(prompt).toContain('(empty — nothing is staged)')
  })

  it('keeps the child out of the worktree it is describing', () => {
    const prompt = buildBriefPrompt(facts(), '')
    expect(prompt).toContain('Do not modify anything')
    expect(prompt).toContain('the diff above is the whole')
  })

  it('clips a huge diff and says the rest is one command away', () => {
    const prompt = buildBriefPrompt(facts(), 'x'.repeat(BRIEF_DIFF_CHARS + 500))
    expect(prompt).toContain('(truncated — run `git diff` for the rest)')
    expect(prompt.length).toBeLessThan(BRIEF_DIFF_CHARS + 4000)
  })
})

describe('createPrBrief', () => {
  it('returns what the child answered', async () => {
    const { deps, started, disposed } = wiring({ text: GOOD_ANSWER })
    const outcome = await createPrBrief(deps)('session-3', facts())
    expect(outcome).toEqual({
      brief: expect.objectContaining({ branchSlug: 'name-branches-from-content' }),
    })
    expect(started).toHaveLength(1)
    expect(started[0]?.prompt).toContain('abc1234 name the branch from the content')
    expect(started[0]?.label).toBe('pull request brief')
    expect(disposed()).toBe(1)
  })

  it('collects the diff itself when the facts do not carry a base', async () => {
    const asked: string[][] = []
    const git: CliRunner = {
      runSync: () => ({ stdout: 'main\n', stderr: '', code: 0 }),
      run: async (args) => {
        asked.push(args)
        if (args[0] === 'symbolic-ref') return { stdout: 'main\n', stderr: '', code: 0 }
        if (args[0] === 'merge-base') return { stdout: 'cafe1234\n', stderr: '', code: 0 }
        return { stdout: args[0] === 'diff' ? '+added' : '', stderr: '', code: 0 }
      },
    }
    const sub = fakeSubagents({ text: '- a change' })
    const outcome = await createPrBrief({
      subagents: () => sub.service,
      parentFor: () => ({ id: 'session-3' }),
      git,
      config: testConfig(),
    })('session-3', facts({ base: undefined }))
    expect(asked).toContainEqual(['diff', 'cafe1234'])
    expect(outcome).toEqual({ brief: expect.objectContaining({ bullets: ['a change'] }) })
  })

  it('says why when the service, the provider, or the parent is missing', async () => {
    const base = { git: fakeGit(), parentFor: () => ({ id: 'session-3' }) }
    const noService = await createPrBrief({ ...base, subagents: () => undefined, config: testConfig() })('session-3', facts())
    expect(noService).toEqual({ error: expect.stringContaining('subagent service is not available') })

    const empty = fakeSubagents({ text: GOOD_ANSWER })
    const noProvider = await createPrBrief({
      ...base,
      subagents: () => ({ list: () => [], start: empty.service.start }),
      config: testConfig(),
    })('session-3', facts())
    expect(noProvider).toEqual({ error: expect.stringContaining('no subagent provider is registered') })

    const sub = fakeSubagents({ text: GOOD_ANSWER })
    const noAgent = await createPrBrief({
      subagents: () => sub.service,
      parentFor: () => undefined,
      git: fakeGit(),
      config: testConfig(),
    })('session-3', facts())
    expect(noAgent).toEqual({ error: expect.stringContaining('no live agent to delegate to') })
  })

  it('reports a child that did not finish, without throwing', async () => {
    const { deps } = wiring({ text: GOOD_ANSWER, stopReason: 'refusal' })
    const outcome = await createPrBrief(deps)('session-3', facts())
    expect(outcome).toEqual({ error: expect.stringContaining('declined the task') })
  })

  it('reports a child that never answers, and still disposes it', async () => {
    const { deps, disposed } = wiring({ never: true }, { prBriefTimeoutMs: 40 })
    const started = Date.now()
    const outcome = await createPrBrief(deps)('session-3', facts())
    expect(outcome).toEqual({ error: expect.stringContaining('did not answer within 40 ms') })
    expect(Date.now() - started).toBeLessThan(2000)
    expect(disposed()).toBe(1)
  })

  it('reports an answer it could not read', async () => {
    const { deps } = wiring({ text: 'I could not summarize this change.' })
    const outcome = await createPrBrief(deps)('session-3', facts())
    expect(outcome).toEqual({ error: expect.stringContaining('could not be read') })
  })

  it('reports a delegation that was refused', async () => {
    const { deps } = wiring({ startThrows: 'provider is busy' })
    const outcome = await createPrBrief(deps)('session-3', facts())
    expect(outcome).toEqual({ error: expect.stringContaining('provider is busy') })
  })

  it('cuts off a delegation that never lands, and closes the child if it lands late', async () => {
    const { deps, disposed } = wiring({ text: GOOD_ANSWER, startLate: 60 }, { prBriefTimeoutMs: 20 })
    const outcome = await createPrBrief(deps)('session-3', facts())
    expect(outcome).toEqual({ error: expect.stringContaining('could not be started within 20 ms') })
    expect(disposed()).toBe(0)
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(disposed()).toBe(1)
  })
})
