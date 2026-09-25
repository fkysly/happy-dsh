import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DISTRIBUTION_VERSION_PATH, distributionVersion } from '../client-build-environment.ts'
import {
  nextDevelopmentVersion,
  parseVersion,
  readVersion,
  releaseTag,
  releaseVersion,
  writeVersion,
} from './version.ts'

const roots: string[] = []
const VERSION_FILE = 'happy-dsh.version'

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'happy-dsh-version-'))
  roots.push(root)
  return root
}

describe('happy-dsh version', () => {
  it('parses both accepted shapes and nothing else', () => {
    expect(parseVersion('0.1.0')).toEqual({ core: '0.1.0' })
    expect(parseVersion('0.1.0-dev.2')).toEqual({ core: '0.1.0', development: 2 })
    expect(parseVersion('12.34.56-dev.789')).toEqual({ core: '12.34.56', development: 789 })

    // Upstream's tags, which this line deliberately does not use.
    expect(() => { parseVersion('0.1.7-rc.1') }).toThrow(/uses -dev\.<n>/)
    // A counter that could not be incremented, and shapes that are not versions.
    expect(() => { parseVersion('0.1.0-dev.0') }).toThrow(/uses -dev\.<n>/)
    expect(() => { parseVersion('0.1.0-dev.two') }).toThrow(/uses -dev\.<n>/)
    expect(() => { parseVersion('0.1.0-dev.1.2') }).toThrow(/uses -dev\.<n>/)
    expect(() => { parseVersion('v0.1.0') }).toThrow(/must look like/)
    expect(() => { parseVersion('0.1') }).toThrow(/must look like/)
    expect(() => { parseVersion('0.1.0 ') }).toThrow(/must look like/)
  })

  it('advances the development counter, and opens the next patch after a release', () => {
    expect(nextDevelopmentVersion('0.1.0-dev.1')).toBe('0.1.0-dev.2')
    expect(nextDevelopmentVersion('0.1.0-dev.9')).toBe('0.1.0-dev.10')
    expect(nextDevelopmentVersion('0.1.0')).toBe('0.1.1-dev.1')
    expect(nextDevelopmentVersion('0.1.9')).toBe('0.1.10-dev.1')
  })

  it('strips the counter to name the releasable version', () => {
    expect(releaseVersion('0.1.0-dev.3')).toBe('0.1.0')
    expect(() => { releaseVersion('0.1.0') }).toThrow(/already holds release version/)
    expect(releaseTag('0.1.0')).toBe('happy-dsh-v0.1.0')
  })

  it('reads and writes one line in one file', () => {
    const root = fixtureRoot()
    expect(() => { readVersion(root) }).toThrow(new RegExp(`${VERSION_FILE} is missing`))

    writeVersion(root, '0.1.0-dev.1')
    expect(readFileSync(resolve(root, VERSION_FILE), 'utf8')).toBe('0.1.0-dev.1\n')
    expect(readVersion(root)).toBe('0.1.0-dev.1')

    // A refused write leaves the recorded version alone.
    expect(() => { writeVersion(root, 'not-a-version') }).toThrow(/must look like/)
    expect(readVersion(root)).toBe('0.1.0-dev.1')
  })

  it('resolves the fork version beside the manifest version', () => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'package.json'), `${JSON.stringify({ version: '0.1.7-rc.1' })}\n`)
    expect(distributionVersion(root)).toBeUndefined()

    writeFileSync(join(root, VERSION_FILE), '0.1.0-dev.1\n')
    expect(distributionVersion(root)).toBe('0.1.0-dev.1')

    writeFileSync(join(root, VERSION_FILE), 'spoofed\n')
    expect(() => distributionVersion(root)).toThrow(/invalid version/)
    expect(DISTRIBUTION_VERSION_PATH).toBe(VERSION_FILE)
  })
})
