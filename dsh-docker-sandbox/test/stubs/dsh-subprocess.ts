/** Minimal stand-in for `@deepseek-ai/dsh-subprocess` (see vitest.config.ts). */

export class SubprocessExecutableNotFoundError extends Error {}

export class Service {
  constructor(
    protected ctx: any,
    public readonly name: string,
  ) {}
}

export abstract class SubprocessRuntime extends Service {}
