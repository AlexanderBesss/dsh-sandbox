import { describe, expect, it } from 'vitest'
import { opIdFactory } from '../src/utils/op-id.ts'

describe('opIdFactory', () => {
  it('keeps one nonce per factory and increments the sequence', () => {
    const next = opIdFactory('op')
    const first = next()
    const second = next()
    expect(first).toMatch(/^op[a-z0-9]{1,6}1$/)
    expect(second).toMatch(/^op[a-z0-9]{1,6}2$/)
    expect(first.slice(0, -1)).toBe(second.slice(0, -1))
  })

  it('never repeats an id within or across factories', () => {
    const a = opIdFactory('a')
    const b = opIdFactory('b')
    const seen = new Set<string>()
    for (let i = 0; i < 50; i++) {
      seen.add(a())
      seen.add(b())
    }
    expect(seen.size).toBe(100)
  })
})
