import { describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { CliCommandError } from '../src/container/git/runner.ts'
import { SandboxUnavailableError } from '../src/container/transport.ts'
import { createSubagentRunRegistry, registerStatusRoute, type StatusDeps } from '../src/status.ts'
import type { SandboxContext, WebRoute } from '../src/context.ts'
import { testConfig } from './helpers.ts'

const HOST = '127.0.0.1:19387'
const SESSION = 'session-3'
const WORKSPACE = 'F:\\Projects\\dsh-sandbox'

function dispatch(
  url: string,
  deps: StatusDeps,
  sessions: (id: string) => unknown = (id) => (id === SESSION ? { id, header: { cwd: WORKSPACE } } : undefined),
): Promise<{ status: number; body: Record<string, never> | Record<string, unknown> }> {
  let handler: WebRoute['handler'] | undefined
  const ctx = {
    effect: (run: () => void) => run(),
    webServer: {
      register: (route: WebRoute) => {
        handler = route.handler
        return () => {}
      },
    },
    sessions: { get: sessions },
  } as unknown as SandboxContext
  registerStatusRoute(ctx, deps)
  const request = { method: 'GET', url, headers: { host: HOST } } as IncomingMessage
  return new Promise((resolve) => {
    let status = 0
    const response = {
      writeHead: (code: number) => {
        status = code
        return response
      },
      end: (payload?: string) => resolve({ status, body: payload === undefined ? {} : (JSON.parse(payload) as Record<string, unknown>) }),
    } as unknown as ServerResponse
    void handler!(request, response)
  })
}

function errorCode(body: Record<string, unknown>): string {
  return (body.error as { code?: string } | undefined)?.code ?? ''
}

function errorMessage(body: Record<string, unknown>): string {
  return (body.error as { message?: string } | undefined)?.message ?? ''
}

function depsStub(overrides: Record<string, unknown> = {}, logged: string[] = []): StatusDeps {
  return {
    provisioner: { status: async () => ({ running: true }), listOwned: async () => [] },
    config: testConfig(),
    connection: { admit: () => ({ peer: {} }) },
    resolvers: { tryStart: () => ({ release: () => {} }) },
    runs: createSubagentRunRegistry(),
    logger: { warn: (message: unknown) => logged.push(String(message)) },
    ...overrides,
  } as unknown as StatusDeps
}

describe('status route actions', () => {
  it('answers the status payload for the status action', async () => {
    const answer = await dispatch(`/sandbox/api/status?session=${SESSION}`, depsStub())
    expect(answer.status).toBe(200)
    expect((answer.body.data as { running: boolean }).running).toBe(true)
  })

  it('rejects an unknown action instead of falling through to the status payload', async () => {
    const answer = await dispatch(`/sandbox/api/whatever?session=${SESSION}`, depsStub())
    expect(answer.status).toBe(400)
    expect(errorCode(answer.body)).toBe('unknown-action')
    expect(answer.body.data).toBeUndefined()
  })

  it('keeps the bare route as a status request', async () => {
    const answer = await dispatch(`/sandbox/api?session=${SESSION}`, depsStub())
    expect(answer.status).toBe(200)
  })
})

describe('status route error wire format', () => {
  it('replaces an unexpected error with a generic message and logs the real one', async () => {
    const logged: string[] = []
    const deps = depsStub(
      { provisioner: { status: async () => { throw new Error('ENOENT: open F:\\Users\\operator\\secrets\\token.txt') } } },
      logged,
    )
    const answer = await dispatch(`/sandbox/api/status?session=${SESSION}`, deps)
    expect(answer.status).toBe(500)
    expect(errorCode(answer.body)).toBe('unknown')
    expect(errorMessage(answer.body)).not.toContain('secrets')
    expect(logged.some((line) => line.includes('ENOENT'))).toBe(true)
  })

  it('passes a CliCommandError code and message through, capped in length', async () => {
    const deps = depsStub({
      worktrees: {
        info: () => {
          throw new CliCommandError(`git merge origin/main failed with exit code 1 ${'x'.repeat(900)}`, 'GIT_FAILED')
        },
      },
    })
    const answer = await dispatch(`/sandbox/api/status?session=${SESSION}`, deps)
    expect(answer.status).toBe(500)
    expect(errorCode(answer.body)).toBe('GIT_FAILED')
    expect(errorMessage(answer.body)).toMatch(/^git merge origin\/main failed/)
    expect(errorMessage(answer.body).length).toBeLessThanOrEqual(500)
  })

  it('passes a SandboxUnavailableError through', async () => {
    const deps = depsStub({
      provisioner: {
        status: async () => {
          throw new SandboxUnavailableError('docker failed: daemon not running', 'EXEC_FAILED')
        },
      },
    })
    const answer = await dispatch(`/sandbox/api/status?session=${SESSION}`, deps)
    expect(answer.status).toBe(500)
    expect(errorCode(answer.body)).toBe('EXEC_FAILED')
    expect(errorMessage(answer.body)).toContain('daemon not running')
  })
})
