import { describe, expect, it } from 'vitest'
import { parseCliArgs } from '../../src/cli/args.ts'

describe('parseCliArgs', () => {
  it('defaults setup to the web profile and port 8080', () => {
    expect(parseCliArgs(['setup'])).toEqual({
      command: 'setup',
      profile: 'web',
      port: 8080,
      json: false,
    })
  })

  it('parses setup profile, URL, port, and JSON output', () => {
    expect(parseCliArgs(['setup', '--profile', 'work', '--url', 'https://search.example', '--port', '9090', '--json'])).toEqual({
      command: 'setup',
      profile: 'work',
      url: 'https://search.example',
      port: 9090,
      json: true,
    })
  })

  it.each(['status', 'doctor'])('parses %s with defaults', (command) => {
    expect(parseCliArgs([command])).toEqual({ command, profile: 'web', port: 8080, json: false })
  })

  it('parses remove flags', () => {
    expect(parseCliArgs(['remove', '--service', '--purge-data', '--yes', '--json'])).toEqual({
      command: 'remove',
      profile: 'web',
      port: 8080,
      json: true,
      service: true,
      purgeData: true,
      yes: true,
    })
  })

  it.each([
    ['unknown command', ['wat']],
    ['empty profile', ['setup', '--profile', '']],
    ['slash profile', ['setup', '--profile', 'a/b']],
    ['backslash profile', ['setup', '--profile', 'a\\b']],
    ['dot-segment profile', ['setup', '--profile', 'a/../b']],
    ['port below range', ['setup', '--port', '0']],
    ['port above range', ['setup', '--port', '65536']],
    ['noninteger port', ['setup', '--port', '8080.5']],
    ['purge without service', ['remove', '--purge-data']],
  ] as const)('rejects %s', (_name, argv) => {
    expect(() => parseCliArgs(argv)).toThrow()
  })
})
