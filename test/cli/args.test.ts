import { describe, expect, it } from 'vitest'
import { parseCliArgs } from '../../src/cli/args.ts'

describe('parseCliArgs', () => {
  it.each([['--help'], ['-h']])('parses %s without requiring a command', (flag) => {
    expect(parseCliArgs([flag])).toEqual({ command: 'help' })
  })

  it('rejects help combined with mutations', () => {
    expect(() => parseCliArgs(['setup', '--help'])).toThrow(/cannot be combined/i)
  })
  it('defaults setup to the web profile and port 8080', () => {
    expect(parseCliArgs(['setup'])).toEqual({
      command: 'setup',
      profile: 'web',
      port: 8080,
      portExplicit: false,
      json: false,
    })
  })

  it('parses setup profile, URL, port, and JSON output', () => {
    expect(parseCliArgs(['setup', '--profile', 'work', '--url', 'https://search.example', '--port', '9090', '--json'])).toEqual({
      command: 'setup',
      profile: 'work',
      url: 'https://search.example',
      port: 9090,
      portExplicit: true,
      json: true,
    })
  })

  it('accepts an absolute HTTP(S) URL with a subpath', () => {
    expect(parseCliArgs(['setup', '--url', 'https://search.example/searxng'])).toMatchObject({
      command: 'setup',
      url: 'https://search.example/searxng',
    })
  })

  it.each([1, 65535])('accepts setup port boundary %s', (port) => {
    expect(parseCliArgs(['setup', '--port', String(port)])).toMatchObject({ command: 'setup', port, portExplicit: true })
  })

  it.each(['status', 'doctor'])('parses %s with defaults', (command) => {
    expect(parseCliArgs([command])).toEqual({ command, profile: 'web', json: false })
  })

  it('parses repair with defaults', () => {
    expect(parseCliArgs(['repair'])).toEqual({ command: 'repair', profile: 'web', json: false })
  })

  it('parses repair profile and JSON output', () => {
    expect(parseCliArgs(['repair', '--profile', 'work', '--json'])).toEqual({
      command: 'repair',
      profile: 'work',
      json: true,
    })
  })

  it('parses remove flags', () => {
    expect(parseCliArgs(['remove', '--service', '--purge-data', '--yes', '--json'])).toEqual({
      command: 'remove',
      profile: 'web',
      json: true,
      service: true,
      purgeData: true,
      yes: true,
    })
  })

  it('parses update with defaults', () => {
    expect(parseCliArgs(['update'])).toEqual({ command: 'update', profile: 'web', json: false })
  })

  it('parses update profile, deployment version, and JSON output', () => {
    expect(parseCliArgs(['update', '--profile', 'work', '--deployment-version', '2', '--json'])).toEqual({
      command: 'update',
      profile: 'work',
      deploymentVersion: 2,
      json: true,
    })
  })

  it('keeps remove defaults explicit', () => {
    expect(parseCliArgs(['remove'])).toEqual({
      command: 'remove',
      profile: 'web',
      json: false,
      service: false,
      purgeData: false,
      yes: false,
    })
  })

  it.each([
    ['unknown command', ['wat']],
    ['empty profile', ['setup', '--profile', '']],
    ['slash profile', ['setup', '--profile', 'a/b']],
    ['backslash profile', ['setup', '--profile', 'a\\b']],
    ['dot-segment profile', ['setup', '--profile', 'a/../b']],
    ['dot profile', ['setup', '--profile', '.']],
    ['dot-dot profile', ['setup', '--profile', '..']],
    ['port below range', ['setup', '--port', '0']],
    ['port above range', ['setup', '--port', '65536']],
    ['noninteger port', ['setup', '--port', '8080.5']],
    ['URL without scheme', ['setup', '--url', 'search.example']],
    ['non-http URL', ['setup', '--url', 'ftp://search.example']],
    ['URL with query', ['setup', '--url', 'https://search.example/?q=1']],
    ['URL with fragment', ['setup', '--url', 'https://search.example/#top']],
    ['URL with username', ['setup', '--url', 'https://user@search.example']],
    ['URL with password', ['setup', '--url', 'https://:secret@search.example']],
    ['remove yes without purge-data', ['remove', '--yes']],
    ['status port', ['status', '--port', '8081']],
    ['doctor port', ['doctor', '--port', '8081']],
    ['remove port', ['remove', '--port', '8081']],
    ['status URL', ['status', '--url', 'https://search.example']],
    ['doctor URL', ['doctor', '--url', 'https://search.example']],
    ['remove URL', ['remove', '--url', 'https://search.example']],
    ['setup service', ['setup', '--service']],
    ['setup purge-data', ['setup', '--purge-data']],
    ['setup yes', ['setup', '--yes']],
    ['status service', ['status', '--service']],
    ['doctor service', ['doctor', '--service']],
    ['status purge-data', ['status', '--purge-data']],
    ['doctor purge-data', ['doctor', '--purge-data']],
    ['status yes', ['status', '--yes']],
    ['doctor yes', ['doctor', '--yes']],
    ['repair port', ['repair', '--port', '8081']],
    ['repair URL', ['repair', '--url', 'https://search.example']],
    ['repair service', ['repair', '--service']],
    ['repair purge-data', ['repair', '--purge-data']],
    ['repair yes', ['repair', '--yes']],
    ['purge without service', ['remove', '--purge-data']],
    ['zero deployment version', ['update', '--deployment-version', '0']],
    ['noninteger deployment version', ['update', '--deployment-version', '2.5']],
    ['setup deployment version', ['setup', '--deployment-version', '2']],
    ['status deployment version', ['status', '--deployment-version', '2']],
    ['doctor deployment version', ['doctor', '--deployment-version', '2']],
    ['repair deployment version', ['repair', '--deployment-version', '2']],
    ['remove deployment version', ['remove', '--deployment-version', '2']],
    ['update port', ['update', '--port', '8081']],
    ['update url', ['update', '--url', 'https://search.example']],
    ['update service', ['update', '--service']],
  ] as const)('rejects %s', (_name, argv) => {
    expect(() => parseCliArgs(argv)).toThrow()
  })
})
