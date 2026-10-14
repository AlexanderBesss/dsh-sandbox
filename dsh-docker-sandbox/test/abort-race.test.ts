import { describe, expect, it } from 'vitest'
import { raceAbort } from '../src/utils/abort-race.ts'

describe('raceAbort', () => {
  it('passes the resolved value through when no abort happens', async () => {
    const ac = new AbortController()
    expect(await raceAbort(Promise.resolve('done'), ac.signal, () => 'aborted')).toBe('done')
  })

  it('passes a rejection through', async () => {
    const ac = new AbortController()
    await expect(
      raceAbort(Promise.reject(new Error('boom')), ac.signal, () => 'aborted'),
    ).rejects.toThrow('boom')
  })

  it('takes the abort path when the signal fires mid-flight', async () => {
    const ac = new AbortController()
    const never = new Promise<string>(() => undefined)
    const racing = raceAbort(never, ac.signal, () => 'aborted')
    ac.abort()
    expect(await racing).toBe('aborted')
  })

  it('rejects when onAbort throws, as the provisioner relies on', async () => {
    const ac = new AbortController()
    const never = new Promise<string>(() => undefined)
    const racing = raceAbort(never, ac.signal, () => {
      throw new Error('cancelled')
    })
    ac.abort()
    await expect(racing).rejects.toThrow('cancelled')
  })

  it('lets the promise win when the signal was already aborted', async () => {
    const ac = new AbortController()
    ac.abort()
    expect(await raceAbort(Promise.resolve('done'), ac.signal, () => 'aborted')).toBe('done')
  })
})
