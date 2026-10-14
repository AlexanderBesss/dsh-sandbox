import { describe, expect, it } from 'vitest'
import {
  MAX_BODY_CHARS,
  prBodyFor,
  prTitleFor,
  type PullRequestFacts,
} from '../src/container/pr-description.ts'

function facts(overrides: Partial<PullRequestFacts> = {}): PullRequestFacts {
  return {
    sessionId: 'session-3',
    branch: 'dsh-sbx/fix-the-login-crash-1a2b3c',
    worktreePath: 'F:\\Projects\\repo.worktrees\\fix-the-login-crash-1a2b3c',
    mainWorkspace: 'F:\\Projects\\repo',
    container: 'dsh-sbx-session-3',
    base: 'deadbeefcafe',
    log: 'abc1234 fix the login crash\n5678def cover it with a test',
    stat: ' src/login.ts | 12 ++++++++\n 1 file changed, 12 insertions(+)',
    committed: false,
    ...overrides,
  }
}

describe('prTitleFor', () => {
  it('titles the request after the conversation', () => {
    expect(prTitleFor(facts({ title: 'Fix the login crash' }))).toBe('Fix the login crash')
  })

  it('reads the branch back as a phrase when the app has no title', () => {
    // The uniqueness digest is dropped: a pull-request list should not end a
    // sentence in hex.
    expect(prTitleFor(facts({ branch: 'dsh-sbx/fix-the-login-crash-1a2b3c' }))).toBe('Fix the login crash')
  })

  it('keeps a session-named branch honest instead of humanizing an id', () => {
    expect(prTitleFor(facts({ branch: 'dsh-sbx/session-3' }))).toBe('dsh-sbx/session-3')
    expect(prTitleFor(facts({ branch: 'dsh-sbx/session-f8618c70-58f9-42f0-ab30-616e2a3777be' })))
      .toBe('dsh-sbx/session-f8618c70-58f9-42f0-ab30-616e2a3777be')
  })

  it('cuts a title to something a pull-request list can show', () => {
    const title = prTitleFor(facts({ title: 'x'.repeat(300) }))
    expect(title.length).toBeLessThanOrEqual(100)
  })

  it('prefers the naming pass over the chat title', () => {
    // A chat is often named after its first message, not after the change.
    expect(prTitleFor(facts({ title: 'Also, when we create a branch', briefTitle: 'Name the branch from the change' })))
      .toBe('Name the branch from the change')
    expect(prTitleFor(facts({ title: 'Fix the login crash', briefTitle: '  ' }))).toBe('Fix the login crash')
  })
})

describe('prBodyFor', () => {
  it('describes the conversation, the branch, and what it changed', () => {
    const body = prBodyFor(facts({ title: 'Fix the login crash' }))
    expect(body).toContain('**Fix the login crash**')
    expect(body).toContain('`session-3`')
    expect(body).toContain('`dsh-sbx/fix-the-login-crash-1a2b3c`')
    expect(body).toContain('commit `deadbeefcafe`')
    expect(body).toContain('## Commits (2)')
    expect(body).toContain('abc1234 fix the login crash')
    expect(body).toContain('src/login.ts | 12')
    expect(body).toContain('dsh-sbx-session-3')
  })

  it('puts the AI bullets above the git evidence, and keeps the git evidence', () => {
    const body = prBodyFor(facts({ summary: ['names the branch', 'describes the request'] }))
    expect(body).toContain('## Summary\n\n- names the branch\n- describes the request')
    expect(body.indexOf('## Summary')).toBeLessThan(body.indexOf('## Commits'))
    expect(body).toContain('abc1234 fix the login crash')
    expect(prBodyFor(facts({ summary: [] }))).not.toContain('## Summary')
  })

  it('says when the button wrote the commit itself', () => {
    expect(prBodyFor(facts())).not.toContain('committed the worktree')
    expect(prBodyFor(facts({ committed: true }))).toContain('committed the worktree')
  })

  it('is explicit about having nothing to show', () => {
    const body = prBodyFor(facts({ log: '', stat: '', base: undefined, title: undefined }))
    expect(body).toContain('(none)')
    expect(body).toContain('(no tracked changes)')
    expect(body).toContain("the main checkout's `HEAD`")
    expect(body).toContain('`session-3`')
  })

  it('stays inside the size a host accepts, and says when it cut', () => {
    const body = prBodyFor(facts({ stat: 'x'.repeat(100_000), log: 'y'.repeat(100_000) }))
    expect(body.length).toBeLessThanOrEqual(MAX_BODY_CHARS)
    expect(body).toContain('(truncated)')
  })
})
