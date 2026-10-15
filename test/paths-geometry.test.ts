import { describe, expect, it } from 'vitest'
import {
  driveToWindowsPath,
  hostToWindows,
  isUnder,
  isWindowsAbsolute,
  isWindowsPath,
  normalize,
  resolveSegments,
  windowsSuffix,
  windowsToDrivePath,
  workspaceDriveRoot,
} from '../src/container/paths/geometry.ts'

describe('isUnder', () => {
  it('accepts the prefix itself and its children', () => {
    expect(isUnder('/ws', '/ws')).toBe(true)
    expect(isUnder('/ws/sub', '/ws')).toBe(true)
    expect(isUnder('/ws/sub/deep', '/ws')).toBe(true)
  })

  it('rejects siblings that share a textual prefix', () => {
    expect(isUnder('/foo-bar', '/foo')).toBe(false)
    expect(isUnder('/foo-bar/x', '/foo')).toBe(false)
    expect(isUnder('/fo', '/foo')).toBe(false)
  })

  it('treats a trailing slash on the path as a child of the prefix', () => {
    expect(isUnder('/ws/', '/ws')).toBe(true)
  })
})

describe('normalize', () => {
  it('converts backslashes, collapses repeats, and trims the trailing slash', () => {
    expect(normalize('C:\\foo\\bar')).toBe('C:/foo/bar')
    expect(normalize('C://foo///')).toBe('C:/foo')
    expect(normalize('/a/b/')).toBe('/a/b')
  })

  it('keeps root and empty inputs', () => {
    expect(normalize('/')).toBe('/')
    expect(normalize('')).toBe('')
  })
})

describe('resolveSegments', () => {
  it('drops . segments and resolves .. within the path', () => {
    expect(resolveSegments('/ws/./sub/../x')).toBe('/ws/x')
  })

  it('cannot escape an absolute path past its root', () => {
    expect(resolveSegments('/a/../..')).toBe('/')
  })

  it('resolves .. within a relative path', () => {
    expect(resolveSegments('a/../b')).toBe('b')
  })

  it('collapses to .. when a relative path climbs past its start', () => {
    expect(resolveSegments('a/../../b')).toBe('..')
  })
})

describe('drive path conversion', () => {
  it('maps a Windows path to its drive-rooted container path', () => {
    expect(windowsToDrivePath('F:\\Projects\\dsh-sandbox')).toBe('/f/Projects/dsh-sandbox')
    expect(windowsToDrivePath('C:\\')).toBe('/c')
  })

  it('normalizes non-Windows input unchanged', () => {
    expect(windowsToDrivePath('/f/Projects/')).toBe('/f/Projects')
  })

  it('maps a drive-rooted container path back to Windows form', () => {
    expect(driveToWindowsPath('/f/Projects/x')).toBe('F:\\Projects\\x')
    expect(driveToWindowsPath('/f')).toBe('F:\\')
  })

  it('returns undefined for paths without a drive root', () => {
    expect(driveToWindowsPath('/ws/sub')).toBeUndefined()
  })

  it('round-trips through both directions', () => {
    expect(driveToWindowsPath(windowsToDrivePath('F:\\Projects\\dsh-sandbox'))).toBe('F:\\Projects\\dsh-sandbox')
  })
})

describe('windows prefix helpers', () => {
  it('hostToWindows re-slashes the tail of a drive-rooted host path', () => {
    expect(hostToWindows('F:/Projects/dsh-sandbox')).toBe('F:\\Projects\\dsh-sandbox')
  })

  it('windowsSuffix re-slashes the remainder below the mount point', () => {
    expect(windowsSuffix('/ws/sub/dir', '/ws')).toBe('\\sub\\dir')
    expect(windowsSuffix('/ws', '/ws')).toBe('')
  })
})

describe('workspace drive root', () => {
  it('reduces a Windows workspace to its uppercase drive root', () => {
    expect(workspaceDriveRoot('f:\\projects\\dsh-sandbox')).toBe('F:\\')
  })

  it('passes non-Windows input through', () => {
    expect(workspaceDriveRoot('/c/x')).toBe('/c/x')
  })
})

describe('windows path predicates', () => {
  it('isWindowsAbsolute matches drive-letter prefixes only', () => {
    expect(isWindowsAbsolute('C:\\x')).toBe(true)
    expect(isWindowsAbsolute('c:/x')).toBe(true)
    expect(isWindowsAbsolute('/c/x')).toBe(false)
    expect(isWindowsAbsolute('\\\\server\\share')).toBe(false)
  })

  it('isWindowsPath also matches UNC roots', () => {
    expect(isWindowsPath('\\\\server\\share')).toBe(true)
    expect(isWindowsPath('/c/x')).toBe(false)
  })
})
