/** Minimal stand-in for `@deepseek-ai/dsh-fs` (see vitest.config.ts). */

export class FsError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
    this.name = 'FsError'
  }
}

export function FsTargetKey(key: string): string {
  return key
}

export function FsVersion(version: string): string {
  return version
}

export class Service {
  constructor(
    protected ctx: any,
    public readonly name: string,
  ) {}
}

export abstract class FileSystem extends Service {
  get sandboxMode(): string | undefined {
    return undefined
  }
}
