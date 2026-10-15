export class StreamCapture {
  private readonly chunks: Buffer[] = []
  private captured = 0
  truncated = false

  constructor(private readonly maxBytes: number) {}

  onData(data: Buffer): void {
    if (this.captured >= this.maxBytes) {
      this.truncated = true
      return
    }
    this.captured += data.length
    this.chunks.push(data)
    if (this.captured > this.maxBytes) this.truncated = true
  }

  buffer(): Buffer {
    return Buffer.concat(this.chunks)
  }
}
