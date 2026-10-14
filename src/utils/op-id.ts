export function opIdFactory(prefix: string): () => string {
  const nonce = Math.random().toString(36).slice(2, 8)
  let seq = 0
  return () => `${prefix}${nonce}${++seq}`
}
