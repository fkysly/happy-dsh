/**
 * happy-dsh's own version line.
 *
 * This fork publishes its own versions, apart from dsh's. Upstream's version is
 * the root `package.json` field, propagated to every one of their manifests by
 * `pnpm run release:dsh`, so a fork version written there would collide with
 * every upstream release bump. One line in `happy-dsh.version` is the whole
 * footprint instead, and `scripts/client-build-environment.ts` embeds that value
 * in the built client — which is why the Web UI reports the fork version while
 * `dsh --version` keeps reporting the dsh base that plugins declare peer ranges
 * against.
 *
 * Two shapes, and nothing else:
 *
 *   `0.1.0-dev.2`   a development version — `dev` increments the counter
 *   `0.1.0`         a release version — the only shape a tag may name
 *
 *   tsx scripts/happy-dsh/version.ts show
 *   tsx scripts/happy-dsh/version.ts dev
 *   tsx scripts/happy-dsh/version.ts release
 *   tsx scripts/happy-dsh/version.ts set 0.2.0-dev.1
 *   tsx scripts/happy-dsh/version.ts check
 */
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  DISTRIBUTION_VERSION_PATH,
  distributionVersion,
  repositoryVersion,
} from '../client-build-environment.ts'

/** Prefix of the fork's release tags; upstream already owns every `dsh-v*`. */
export const RELEASE_TAG_PREFIX = 'happy-dsh-v'

/** Accepted version shape, identical to the rule the root manifest must satisfy. */
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

/** Accepted development suffix: a counter that never restarts at zero. */
const DEVELOPMENT_PATTERN = /^dev\.[1-9]\d*$/

/** One parsed fork version. */
export interface ForkVersion {
  /** `major.minor.patch`, without any suffix. */
  readonly core: string
  /** Counter of a development version; absent on a release version. */
  readonly development?: number
}

/**
 * Parse a version string into its core triple and optional development counter.
 * @param value - version text, e.g. `0.1.0-dev.2` or `0.1.0`.
 * @returns the parsed version.
 */
export function parseVersion(value: string): ForkVersion {
  if (!VERSION_PATTERN.test(value)) {
    throw new Error(`version ${JSON.stringify(value)} must look like 0.1.0 or 0.1.0-dev.1`)
  }
  const separator = value.indexOf('-')
  if (separator === -1) return { core: value }

  const core = value.slice(0, separator)
  const suffix = value.slice(separator + 1)
  if (!DEVELOPMENT_PATTERN.test(suffix)) {
    throw new Error(
      `version ${JSON.stringify(value)} carries the suffix ${JSON.stringify(suffix)}; `
      + 'the fork version uses -dev.<n> for a development version and no suffix for a release',
    )
  }
  return { core, development: Number(suffix.slice('dev.'.length)) }
}

/**
 * Advance the development line: `-dev.N` becomes `-dev.N+1`, and a release
 * version opens the next patch as `-dev.1`.
 *
 * Opening the next *patch* is a default, not a policy — `set` is how a minor or
 * major line gets named.
 *
 * @param value - current fork version.
 * @returns the next development version.
 */
export function nextDevelopmentVersion(value: string): string {
  const parsed = parseVersion(value)
  if (parsed.development !== undefined) return `${parsed.core}-dev.${parsed.development + 1}`

  const [major = '0', minor = '0', patch = '0'] = parsed.core.split('.')
  return `${major}.${minor}.${Number(patch) + 1}-dev.1`
}

/**
 * Strip the development counter, naming the version a tag may carry.
 * @param value - current fork version, which must be a development version.
 * @returns the release version.
 */
export function releaseVersion(value: string): string {
  const parsed = parseVersion(value)
  if (parsed.development === undefined) {
    throw new Error(`${DISTRIBUTION_VERSION_PATH} already holds release version ${value}; nothing to strip`)
  }
  return parsed.core
}

/**
 * Name the tag that publishes a version.
 * @param value - fork version.
 * @returns the `happy-dsh-v` tag name.
 */
export function releaseTag(value: string): string {
  return `${RELEASE_TAG_PREFIX}${value}`
}

/**
 * Read the fork version of a checkout.
 * @param root - repository root.
 * @returns the version held by `happy-dsh.version`.
 */
export function readVersion(root: string): string {
  const value = distributionVersion(root)
  if (value === undefined) {
    throw new Error(
      `${DISTRIBUTION_VERSION_PATH} is missing; name the line with \`set <version>\` before using it`,
    )
  }
  parseVersion(value)
  return value
}

/**
 * Write the fork version of a checkout.
 * @param root - repository root.
 * @param value - version to record; validated before anything is written.
 */
export function writeVersion(root: string, value: string): void {
  parseVersion(value)
  writeFileSync(resolve(root, DISTRIBUTION_VERSION_PATH), `${value}\n`)
}

const USAGE = `usage: tsx scripts/happy-dsh/version.ts <command>

  show              print the fork version, the dsh base, and the next tag name
  check             validate ${DISTRIBUTION_VERSION_PATH} without writing (CI)
  dev               advance the development counter
  release           strip the development counter, naming a releasable version
  set <version>     write an explicit version, e.g. 0.2.0-dev.1`

/** Repository root, from this file's own location. */
const ROOT = resolve(import.meta.dirname, '..', '..')

/**
 * Run one command, reporting the fork version as it changes.
 * @param argv - arguments after the script path.
 * @returns the process exit code: 0 success, 1 refused, 2 usage.
 */
function main(argv: readonly string[]): number {
  const [command, ...rest] = argv
  try {
    switch (command) {
      case 'show': {
        const value = readVersion(ROOT)
        console.log(`version: ${value}`)
        console.log(`dsh: ${repositoryVersion(ROOT)}`)
        console.log(`tag: ${releaseTag(value)}`)
        return 0
      }
      case 'check': {
        const value = readVersion(ROOT)
        console.log(`happy-dsh version: ${value} (dsh base ${repositoryVersion(ROOT)})`)
        return 0
      }
      case 'dev': {
        const current = readVersion(ROOT)
        const next = nextDevelopmentVersion(current)
        writeVersion(ROOT, next)
        console.log(`happy-dsh version: ${current} -> ${next}`)
        return 0
      }
      case 'release': {
        const current = readVersion(ROOT)
        const next = releaseVersion(current)
        writeVersion(ROOT, next)
        console.log(`happy-dsh version: ${current} -> ${next} (tag ${releaseTag(next)})`)
        return 0
      }
      case 'set': {
        const requested = rest.at(0)
        if (requested === undefined) {
          console.error(USAGE)
          return 2
        }
        writeVersion(ROOT, requested)
        console.log(`happy-dsh version: ${requested}`)
        return 0
      }
      case '-h':
      case '--help': {
        console.log(USAGE)
        return 0
      }
      default: {
        console.error(USAGE)
        return 2
      }
    }
  } catch (error) {
    console.error(`happy-dsh version: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2))
