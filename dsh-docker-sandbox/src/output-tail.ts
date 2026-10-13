/**
 * Bounded retained output with absolute-offset reads.
 *
 * The subprocess seam keeps a capped tail of each stream so callers that
 * await (rather than stream) can still read what the command printed, and
 * job-output pumps can advance a cursor through it. The tail drops from the
 * front once the cap is hit and reports the loss on every read.
 *
 * @module dsh-docker-sandbox/output-tail
 */

import type { OutputTail as SeamOutputTail } from "@deepseek-ai/dsh-subprocess"

/** Bounded retained output with absolute-offset reads. */
export class OutputTail {
  private chunks: Buffer[] = []
  private startOffset = 0
  private total = 0
  private dropped = false

  constructor(private readonly maxBytes: number) {}

  append(data: Buffer): void {
    this.total += data.length
    if (data.length >= this.maxBytes) {
      this.chunks = [data.subarray(data.length - this.maxBytes)]
      this.startOffset = this.total - this.maxBytes
      this.dropped = true
      return
    }
    this.chunks.push(data)
    let buffered = this.chunks.reduce((sum, chunk) => sum + chunk.length, 0)
    while (buffered > this.maxBytes && this.chunks.length > 1) {
      const first = this.chunks.shift()!
      buffered -= first.length
      this.startOffset += first.length
      this.dropped = true
    }
  }

  get bytes(): number {
    return this.total
  }

  get lossy(): boolean {
    return this.dropped
  }

  get text(): string {
    return this.readFrom(this.startOffset)?.text ?? ""
  }

  /**
   * Read from an absolute offset. A collected stream always answers — an
   * empty stream reads as empty text, not as "no stream": the shipped search
   * provider treats an `undefined` read as "the command produced no collected
   * output streams", which would fail every ripgrep run whose stderr is empty
   * (that is, nearly all of them). `nextOffset` mirrors the shipped collector
   * so job output pumps can advance their cursor.
   */
  readFrom(offset: number): { text: string; nextOffset: number; lossy: boolean } {
    const from = Math.max(offset, this.startOffset)
    const lossy = this.dropped || offset < this.startOffset
    if (from >= this.total) return { text: "", nextOffset: this.total, lossy }
    const buffer = Buffer.concat(this.chunks)
    return {
      text: buffer.subarray(from - this.startOffset).toString("utf8"),
      nextOffset: this.total,
      lossy,
    }
  }
}

/** Adapt the internal tail to the seam's read shape. */
export function tailView(tail: OutputTail): SeamOutputTail {
  return {
    readFrom: (offset: number) => tail.readFrom(offset),
    get text() {
      return tail.text
    },
    get lossy() {
      return tail.lossy
    },
    get bytes() {
      return tail.bytes
    },
  }
}
