import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { CliCommandError, createCliRunner } from '../src/container/git.ts'

// The real-git suites below must not inherit this process's own worktree
// pointers (GIT_DIR/GIT_WORK_TREE/GIT_CONFIG_*) when they run inside a sandbox.
for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY']) {
  delete process.env[key]
}
for (const key of Object.keys(process.env)) {
  if (key.startsWith('GIT_CONFIG_')) delete process.env[key]
}

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const tempRoots: string[] = []
afterAll(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true })
})

// node parses a bare -c as --check, so the stub binary is a script file: the
// runner's hardening args then arrive as the script's own argv.
function stubScript(name: string, body: string): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-runner-stub-'))
  tempRoots.push(root)
  const path = join(root, name)
  writeFileSync(path, body)
  return path
}

interface SpawnCall {
  argv: string[]
  env?: NodeJS.ProcessEnv
}

// A stub child_process that only records the call; the runner module is
// re-imported so the recorded argv/env come from the real runner code. The
// credential-helper probe is answered separately and kept out of `calls`.
async function runnerRecordingSpawns(baseArgv: string[], label: 'git' | 'gh', probeStdout = '') {
  const calls: SpawnCall[] = []
  const probes: SpawnCall[] = []
  const ok = { status: 0, stdout: '', stderr: '', error: undefined }
  vi.doMock('node:child_process', () => ({
    spawnSync: (command: string, argv: string[], options: { env?: NodeJS.ProcessEnv }) => {
      const target = argv.includes('--show-scope') ? probes : calls
      target.push({ argv: [command, ...argv], env: options.env })
      return probes === target ? { ...ok, stdout: probeStdout } : ok
    },
    spawn: (command: string, argv: string[], options: { env?: NodeJS.ProcessEnv }) => {
      calls.push({ argv: [command, ...argv], env: options.env })
      return {
        stdout: { on: () => undefined },
        stderr: { on: () => undefined },
        stdin: { on: () => undefined, end: () => undefined },
        kill: () => undefined,
        once: (event: string, listener: (code: number) => void) => {
          if (event === 'close') queueMicrotask(() => listener(0))
        },
      }
    },
  }))
  vi.resetModules()
  const module = await import('../src/container/git.ts')
  return { calls, probes, runner: module.createCliRunner(baseArgv, label) }
}

const OVERRIDES = [
  'core.fsmonitor=false',
  'core.pager=cat',
  'sequence.editor=true',
  'core.editor=true',
  'protocol.ext.allow=never',
  'core.sshCommand=ssh',
  'core.askPass=',
  'credential.helper=',
]

const HARDENING_ENV = {
  GIT_ALLOW_PROTOCOL: 'https:ssh:file',
  GIT_TERMINAL_PROMPT: '0',
  GIT_PAGER: 'cat',
  GIT_EDITOR: 'true',
  GIT_SEQUENCE_EDITOR: 'true',
  GIT_MERGE_AUTOEDIT: 'no',
  GIT_ASKPASS: '',
  SSH_ASKPASS: '',
}

const GH_CONFIG: [string, string][] = [
  ['GIT_CONFIG_KEY_0', 'core.hooksPath'],
  ['GIT_CONFIG_KEY_1', 'core.fsmonitor'],
  ['GIT_CONFIG_KEY_2', 'protocol.ext.allow'],
  ['GIT_CONFIG_KEY_3', 'core.pager'],
  ['GIT_CONFIG_VALUE_1', 'false'],
  ['GIT_CONFIG_VALUE_2', 'never'],
  ['GIT_CONFIG_VALUE_3', 'cat'],
]

describe('createCliRunner.run', () => {
  it('resolves with the output of a successful call', async () => {
    const runner = createCliRunner([process.execPath, stubScript('echo.mjs', 'process.stdout.write("hi")\n')], 'git')
    const out = await runner.run(['status'])
    expect(out.stdout).toBe('hi')
    expect(out.code).toBe(0)
  })

  it('rejects (not throws) when the child exits non-zero', async () => {
    const runner = createCliRunner([process.execPath, stubScript('fail.mjs', 'process.exit(3)\n')], 'git')
    await expect(runner.run(['status'])).rejects.toThrow(CliCommandError)
  })

  it('rejects with GIT_MISSING when the binary is absent', async () => {
    const runner = createCliRunner(['definitely-not-a-command-xyz'], 'git')
    const error = await runner.run(['status']).catch((e: unknown) => e as CliCommandError)
    expect(error).toBeInstanceOf(CliCommandError)
    expect(error.code).toBe('GIT_MISSING')
  })
})

describe('createCliRunner hardening', () => {
  it('puts -c overrides between the git binary and the subcommand', async () => {
    const { calls, runner } = await runnerRecordingSpawns(['git'], 'git')
    runner.runSync(['status', '--porcelain'])

    const argv = calls[0]!.argv
    expect(argv[0]).toBe('git')
    const subcommand = argv.indexOf('status')
    expect(subcommand).toBeGreaterThan(1)
    const prefix = argv.slice(1, subcommand)
    expect(prefix.every((entry, index) => (index % 2 === 0 ? entry === '-c' : !entry.startsWith('-c')))).toBe(true)
    for (const override of OVERRIDES) expect(prefix).toContain(override)

    const hooks = prefix.find((entry) => entry.startsWith('core.hooksPath='))
    expect(hooks).toBeDefined()
    expect(hooks!.slice('core.hooksPath='.length)).toContain('dsh-docker-sandbox-empty-hooks')
    expect(existsSync(hooks!.slice('core.hooksPath='.length))).toBe(true)
  })

  it('hardens the async runner the same way, leaving the caller argv intact', async () => {
    const { calls, runner } = await runnerRecordingSpawns(['git'], 'git')
    await runner.run(['commit', '-m', 'subject'])

    const argv = calls[0]!.argv
    expect(argv[0]).toBe('git')
    expect(argv.indexOf('commit')).toBeGreaterThan(argv.lastIndexOf('-c'))
    expect(argv.slice(argv.indexOf('commit'))).toEqual(['commit', '-m', 'subject'])
  })

  it('merges the hardening env over the inherited one', async () => {
    process.env.DSH_RUNNER_INHERITED = 'kept'
    const { calls, runner } = await runnerRecordingSpawns(['git'], 'git')
    await runner.run(['push', '-u', 'origin', 'main'])

    const env = calls[0]!.env
    expect(env).toMatchObject({ ...HARDENING_ENV, DSH_RUNNER_INHERITED: 'kept' })
    expect(env!.PATH ?? env!.Path).toBeTruthy()
    delete process.env.DSH_RUNNER_INHERITED
  })

  it('steers the gh child git through env config, leaving gh argv alone', async () => {
    const { calls, runner } = await runnerRecordingSpawns(['gh'], 'gh')
    runner.runSync(['pr', 'create'])

    expect(calls[0]!.argv).toEqual(['gh', 'pr', 'create'])
    const env = calls[0]!.env!
    expect(env.GIT_ALLOW_PROTOCOL).toBe('https:ssh:file')
    expect(env.GIT_CONFIG_COUNT).toBe('4')
    for (const [key, value] of GH_CONFIG) expect(env[key]).toBe(value)
    expect(env.GIT_CONFIG_VALUE_0).toContain('dsh-docker-sandbox-empty-hooks')
    expect(existsSync(env.GIT_CONFIG_VALUE_0!)).toBe(true)
    expect(env.GIT_CONFIG_KEY_4).toBeUndefined()
    expect(Object.keys(env).filter((key) => key.startsWith('GIT_CONFIG_'))).toHaveLength(9)
    expect(env.PATH ?? env.Path).toBeTruthy()
  })

  it('re-appends operator credential helpers after the clearing one, never repo-level ones', async () => {
    const { calls, probes, runner } = await runnerRecordingSpawns(['git'], 'git', [
      'system\tmanager',
      'global\tglobal-helper-kept',
      'local\tevil-local-helper',
      'worktree\tevil-worktree-helper',
    ].join('\n'))
    runner.runSync(['status', '--porcelain'])
    runner.runSync(['fetch', 'origin'])

    expect(probes[0]!.argv).toEqual(['git', 'config', '--show-scope', '--get-all', 'credential.helper'])
    expect(probes).toHaveLength(1)

    const kept = ['credential.helper=', 'credential.helper=manager', 'credential.helper=global-helper-kept']
    for (const call of calls) {
      expect(call.argv.filter((entry) => entry.startsWith('credential.helper='))).toEqual(kept)
      expect(call.argv.join('\n')).not.toContain('evil-local-helper')
      expect(call.argv.join('\n')).not.toContain('evil-worktree-helper')
    }
  })

  it('delivers the overrides and the env through a real spawn', async () => {
    process.env.DSH_RUNNER_INHERITED = 'kept'
    const probe = stubScript(
      'probe.mjs',
      'process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), env: process.env }))\n',
    )
    const out = await createCliRunner([process.execPath, probe], 'git').run(['status'])
    const seen = JSON.parse(out.stdout) as { argv: string[]; env: Record<string, string | undefined> }

    expect(seen.argv[0]).toBe('-c')
    for (const override of OVERRIDES) expect(seen.argv).toContain(override)
    expect(seen.argv[seen.argv.length - 1]).toBe('status')
    expect(seen.env).toMatchObject({ ...HARDENING_ENV, DSH_RUNNER_INHERITED: 'kept' })
    delete process.env.DSH_RUNNER_INHERITED
  })
})

interface TempRepo {
  base: string
  repo: string
  git: (...args: string[]) => void
  gitOut: (...args: string[]) => string
}

function tempRepo(prefix: string): TempRepo {
  const base = mkdtempSync(join(tmpdir(), `dsh-git-${prefix}-`))
  tempRoots.push(base)
  const repo = join(base, 'repo')
  execFileSync('git', ['init', '-b', 'main', repo], { cwd: base, stdio: 'ignore' })
  const git = (...args: string[]) => {
    execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
  }
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  return { base, repo, git, gitOut: (...args: string[]) => execFileSync('git', args, { cwd: repo }).toString() }
}

describe.skipIf(!hasGit)('the hardened runner against real git', () => {
  it('never runs a hook the repository wrote into .git', async () => {
    const { base, repo, git, gitOut } = tempRepo('hook')
    const marker = join(base, 'hook-ran')

    writeFileSync(join(repo, 'a.ts'), 'export const a = 1\n')
    git('add', '-A')
    // sh syntax and forward slashes, so the same hook runs under git-for-Windows sh
    const hook = join(repo, '.git', 'hooks', 'pre-commit')
    writeFileSync(hook, `#!/bin/sh\ntouch "${marker.replace(/\\/g, '/')}"\n`)
    chmodSync(hook, 0o755)

    git('commit', '-m', 'plain host git')
    expect(existsSync(marker)).toBe(true)
    rmSync(marker, { force: true })

    writeFileSync(join(repo, 'b.ts'), 'export const b = 1\n')
    git('add', '-A')
    await createCliRunner(['git'], 'git').run(['commit', '-m', 'through the plugin'], { cwd: repo })

    expect(existsSync(marker)).toBe(false)
    expect(gitOut('log', '--format=%s', '-1').trim()).toBe('through the plugin')
  })

  it('refuses a worktree-touching call when an attribute names a shell filter', async () => {
    const { repo, git, gitOut } = tempRepo('filter')
    const marker = join(repo, 'filter-ran')
    writeFileSync(join(repo, 'a.txt'), 'hello\n')
    writeFileSync(join(repo, '.git', 'info', 'attributes'), '*.txt filter=evil\n')
    git('config', 'filter.evil.clean', `!touch "${marker.replace(/\\/g, '/')}"`)

    const runner = createCliRunner(['git'], 'git')
    await expect(runner.run(['add', '-A'], { cwd: repo })).rejects.toThrow(/filter\.evil\.clean/)
    expect(() => runner.runSync(['status', '--porcelain'], { cwd: repo })).toThrow(/info\/attributes/)
    expect(existsSync(marker)).toBe(false)
    expect(gitOut('status', '--porcelain')).toBe('?? a.txt\n')
  })

  it('lets an LFS-shaped filter through', async () => {
    const { repo, git, gitOut } = tempRepo('lfs')
    writeFileSync(join(repo, 'a.bin'), 'binary-ish\n')
    writeFileSync(join(repo, '.git', 'info', 'attributes'), '*.bin filter=lfs\n')
    git('config', 'filter.lfs.clean', 'git lfs clean %f')
    git('config', 'filter.lfs.smudge', 'git lfs smudge %f')
    git('config', 'filter.lfs.required', 'true')

    const result = await createCliRunner(['git'], 'git').run(['add', '-A'], { cwd: repo })
    expect(result.code).toBe(0)
    expect(gitOut('diff', '--cached', '--name-only')).toBe('a.bin\n')
  })

  it('refuses a linked worktree whose shared config carries the shell filter', async () => {
    const { base, repo, git } = tempRepo('linked')
    writeFileSync(join(repo, 'seed.txt'), 'seed\n')
    git('add', '-A')
    git('commit', '-m', 'seed')
    const worktree = join(base, 'linked')
    git('worktree', 'add', worktree)

    const linkedGit = join(repo, '.git', 'worktrees', 'linked')
    mkdirSync(join(linkedGit, 'info'), { recursive: true })
    writeFileSync(join(linkedGit, 'info', 'attributes'), '*.txt filter=evil\n')
    git('config', 'filter.evil.process', '!touch marker')

    await expect(createCliRunner(['git'], 'git').run(['add', '-A'], { cwd: worktree })).rejects.toThrow(/filter\.evil\.process/)
    expect(existsSync(join(worktree, 'marker'))).toBe(false)
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: worktree }).toString()).toBe('')
  })

  it('lets keys the -c prefix pins through, and proves the pin', () => {
    const { repo, git } = tempRepo('pinned')
    git('config', 'core.fsmonitor', 'C:/evil/monitor.sh')
    git('config', 'core.hooksPath', 'C:/evil/hooks')
    git('config', 'core.sshCommand', '/usr/bin/ssh')
    git('config', 'core.askPass', 'C:/evil/askpass.exe')
    const runner = createCliRunner(['git'], 'git')
    const pinned = (key: string) => runner.runSync(['config', '--get', key], { cwd: repo }).stdout.trim()

    expect(runner.runSync(['status', '--porcelain'], { cwd: repo }).code).toBe(0)
    expect(pinned('core.fsmonitor')).toBe('false')
    expect(pinned('core.hooksPath')).toContain('dsh-docker-sandbox-empty-hooks')
    expect(pinned('core.sshCommand')).toBe('ssh')
    expect(pinned('core.askPass')).toBe('')
  })

  it('refuses a shell alias the repository defined', () => {
    const { repo, git } = tempRepo('alias')
    git('config', 'alias.wipe', '!rm -rf .')
    expect(() => createCliRunner(['git'], 'git').runSync(['status', '--porcelain'], { cwd: repo })).toThrow(/alias\.wipe/)
  })

  it('refuses a local config that includes another file, where the filter would hide', () => {
    const { base, repo, git } = tempRepo('include')
    writeFileSync(join(base, 'evil.gitconfig'), '[filter "evil"]\n\tclean = !touch marker\n')
    git('config', 'include.path', join(base, 'evil.gitconfig').replace(/\\/g, '/'))
    expect(() => createCliRunner(['git'], 'git').runSync(['status', '--porcelain'], { cwd: repo })).toThrow(/include\.path/)
  })

  it('refuses a gitdir-scoped include, whose condition is attacker-chosen', () => {
    const { base, repo, git } = tempRepo('includeif')
    writeFileSync(join(base, 'evil.gitconfig'), '[filter "evil"]\n\tclean = !touch marker\n')
    git('config', 'includeif.gitdir:/x.path', join(base, 'evil.gitconfig').replace(/\\/g, '/'))
    expect(() => createCliRunner(['git'], 'git').runSync(['status', '--porcelain'], { cwd: repo })).toThrow(/includeif\./)
  })
})
