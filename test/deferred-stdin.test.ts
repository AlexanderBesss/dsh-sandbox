import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { DeferredStdin } from '../src/utils/deferred-stdin.ts'

describe('DeferredStdin', () => {
  it('replays buffered writes and a pre-attach end onto the child', () => {
    const deferred = new DeferredStdin()
    const child = new PassThrough()
    const chunks: Buffer[] = []
    child.on('data', (chunk: Buffer) => chunks.push(chunk))

    deferred.stream.write('one')
    deferred.stream.write('two')
    deferred.stream.end()
    deferred.attach(child)

    expect(Buffer.concat(chunks).toString()).toBe('onetwo')
  })

  it('reports backpressure past the cap and drains once attached', () => {
    const deferred = new DeferredStdin()
    let accepted = true
    for (let i = 0; i < 40; i++) accepted = deferred.stream.write(Buffer.alloc(512 * 1024))
    expect(accepted, 'writes past the cap must report backpressure').toBe(false)

    let drained = false
    deferred.stream.on('drain', () => {
      drained = true
    })
    const child = new PassThrough()
    deferred.attach(child)
    child.resume()
    expect(drained, 'attach must release a caller held at the cap').toBe(true)
  })

  it('forwards the child’s own backpressure after attach', () => {
    const deferred = new DeferredStdin()
    const child = new PassThrough({ highWaterMark: 8 })
    deferred.attach(child)
    let accepted = true
    for (let i = 0; i < 20; i++) accepted = deferred.stream.write(Buffer.alloc(64 * 1024))
    expect(accepted).toBe(false)
  })
})
