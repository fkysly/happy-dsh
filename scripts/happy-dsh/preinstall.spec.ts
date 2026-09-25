import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  INSTALLER_PATH,
  README_PATHS,
  missingReferences,
  parsePinnedPlugins,
  readPinnedPlugins,
  referencesOf,
  serializePinnedPlugins,
  stalePins,
  withPinnedPlugins,
  withReferences,
  writePinnedPlugins,
} from './preinstall.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** An installer with the pin line, plus neighbours that must survive a rewrite. */
function installer(pins: string): string {
  return [
    '#!/bin/bash',
    'SKIP_DEFAULT_PLUGINS=0',
    '',
    '# Plugins installed into the profile before the service starts.',
    `DEFAULT_PLUGINS=(${pins})`,
    '',
    'PLUGIN_SPECS=()',
    '',
  ].join('\n')
}

/** A checkout holding the installer and both READMEs, as the real one does. */
function fixtureRoot(pins: string, readme: string): string {
  const root = mkdtempSync(join(tmpdir(), 'happy-dsh-preinstall-'))
  roots.push(root)
  mkdirSync(join(root, 'deploy', 'serve'), { recursive: true })
  writeFileSync(join(root, INSTALLER_PATH), installer(pins))
  for (const relative of README_PATHS) writeFileSync(join(root, relative), readme)
  return root
}

const PAIR = [
  { name: 'dshmarket', version: '1.65.3' },
  { name: 'dsh-find-plugin', version: '0.4.0' },
]
const SPECS = 'dshmarket@1.65.3 dsh-find-plugin@0.4.0'
const DOCS = `| \`${SPECS}\` | preinstalled |\n`

describe('happy-dsh preinstall pins', () => {
  it('reads the pin line and nothing around it', () => {
    expect(parsePinnedPlugins(installer(SPECS))).toEqual(PAIR)
  })

  it('keeps a scoped name whole', () => {
    expect(parsePinnedPlugins(installer('@scope/plugin@1.2.3'))).toEqual([
      { name: '@scope/plugin', version: '1.2.3' },
    ])
  })

  it('refuses a missing line, an empty list, and a range', () => {
    expect(() => parsePinnedPlugins('SKIP_DEFAULT_PLUGINS=0\n')).toThrow(/no DEFAULT_PLUGINS/)
    expect(() => parsePinnedPlugins(installer(''))).toThrow(/pins no preinstalled plugins/)
    expect(() => parsePinnedPlugins(installer('dsh-find-plugin@^0.4.0'))).toThrow(/exact version/)
    expect(() => parsePinnedPlugins(installer('dsh-find-plugin@latest'))).toThrow(/exact version/)
  })

  it('rewrites the pin line and leaves every other byte alone', () => {
    const before = installer(SPECS)
    const after = withPinnedPlugins(before, [
      { name: 'dshmarket', version: '1.66.0' },
      { name: 'dsh-find-plugin', version: '0.4.0' },
    ])
    expect(after).toContain('DEFAULT_PLUGINS=(dshmarket@1.66.0 dsh-find-plugin@0.4.0)')
    expect(after.replace('DEFAULT_PLUGINS=(dshmarket@1.66.0 dsh-find-plugin@0.4.0)',
      'DEFAULT_PLUGINS=(dshmarket@1.65.3 dsh-find-plugin@0.4.0)')).toBe(before)
  })

  it('names the references a document is missing, and rewrites them', () => {
    expect(referencesOf(PAIR)).toEqual(['dshmarket@1.65.3', 'dsh-find-plugin@0.4.0'])
    expect(missingReferences(DOCS, PAIR)).toEqual([])
    expect(missingReferences('nothing here', PAIR)).toEqual(referencesOf(PAIR))

    const bumped = withReferences(DOCS, PAIR, [
      { name: 'dshmarket', version: '1.66.0' },
      { name: 'dsh-find-plugin', version: '0.4.0' },
    ])
    expect(bumped.changed).toBe(true)
    expect(bumped.text).toContain('dshmarket@1.66.0')
    expect(missingReferences(bumped.text, [
      { name: 'dshmarket', version: '1.66.0' },
      { name: 'dsh-find-plugin', version: '0.4.0' },
    ])).toEqual([])

    expect(withReferences(DOCS, PAIR, PAIR)).toEqual({ text: DOCS, changed: false })
  })

  it('reports only the pins the registry disagrees with', () => {
    expect(stalePins(PAIR, new Map([['dshmarket', '1.65.3'], ['dsh-find-plugin', '0.4.0']])))
      .toEqual([])
    expect(stalePins(PAIR, new Map([['dshmarket', '1.66.0'], ['dsh-find-plugin', '0.4.0']])))
      .toEqual([{ name: 'dshmarket', pinned: '1.65.3', latest: '1.66.0' }])
    // A package the registry did not answer for is not a stale pin; the ask
    // itself failed loudly before this point.
    expect(stalePins(PAIR, new Map())).toEqual([])
  })

  it('writes the installer and both READMEs together', () => {
    const root = fixtureRoot(SPECS, DOCS)
    const bumped = [
      { name: 'dshmarket', version: '1.66.0' },
      { name: 'dsh-find-plugin', version: '0.5.0' },
    ]
    expect(writePinnedPlugins(root, bumped)).toEqual({
      installer: true,
      readmes: [...README_PATHS],
    })
    expect(readPinnedPlugins(root)).toEqual(bumped)
    for (const relative of README_PATHS) {
      expect(missingReferences(readFileSync(join(root, relative), 'utf8'), bumped)).toEqual([])
    }
  })

  it('writes nothing when the pins already match', () => {
    const root = fixtureRoot(SPECS, DOCS)
    expect(writePinnedPlugins(root, PAIR)).toEqual({ installer: false, readmes: [] })
    expect(serializePinnedPlugins(readPinnedPlugins(root))).toBe(SPECS)
  })
})
