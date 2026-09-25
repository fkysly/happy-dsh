/**
 * The plugin pair a deployment preinstalls, and the versions of it.
 *
 * `deploy/serve/install.sh` installs two third-party plugins into a profile
 * before the service is loaded, which makes their versions part of what a
 * release promises. They are npm packages on somebody else's release schedule,
 * so nothing in this repository notices when they move — hence this script, and
 * hence the release workflow refuses to publish a stale pair.
 *
 * The pins are not ranges. A range would mean two deployments of the same
 * release install different code, and the smoke that proves a pair boots
 * (`deploy/release/preinstall-smoke.sh`) would be proving it about a version it
 * did not name. `bump` is what keeps an exact pin current.
 *
 * One source of truth, and it is the line that installs them:
 *
 *   deploy/serve/install.sh     DEFAULT_PLUGINS=(dshmarket@1.65.3 dsh-find-plugin@0.4.0)
 *   deploy/serve/README.md      the table that names the same pair, in `name@version`
 *   deploy/serve/README.zh.md   the other half of the pair
 *
 *   tsx scripts/happy-dsh/preinstall.ts show     the pins as install.sh has them
 *   tsx scripts/happy-dsh/preinstall.ts verify   shape + docs, offline (CI)
 *   tsx scripts/happy-dsh/preinstall.ts check    compare against the registry (CI)
 *   tsx scripts/happy-dsh/preinstall.ts bump     take the registry's latest
 *   tsx scripts/happy-dsh/preinstall.ts specs    the raw specs, one per line
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** The installer whose `DEFAULT_PLUGINS` line is the source of truth. */
export const INSTALLER_PATH = 'deploy/serve/install.sh'

/** The documentation that names the same pair, and is checked against it. */
export const README_PATHS = ['deploy/serve/README.md', 'deploy/serve/README.zh.md']

/** Where a pin's currency is decided. */
export const DEFAULT_REGISTRY = 'https://registry.npmjs.org/'

/** How long the registry gets before a check is reported as unanswerable. */
const REGISTRY_TIMEOUT_MS = 15000

/** One pinned plugin: an npm package name and the exact version to install. */
export interface PinnedPlugin {
  /** Package name, including any scope. */
  readonly name: string
  /** Exact version; never a range. */
  readonly version: string
}

/** The one field of a registry document this reads. */
interface RegistryDocument {
  readonly 'dist-tags'?: { readonly latest?: unknown }
}

/** The installer line, matched as a whole so the file cannot drift silently. */
const SPECS_LINE = /^DEFAULT_PLUGINS=\((.*)\)$/m

/**
 * One `name@version` token. The version is exact by construction: a range here
 * would let a release install code the smoke never saw.
 */
const SPEC_TOKEN = /^(@[^/@]+\/)?([^@/]+)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/

/**
 * Read the pinned pair out of an installer's text.
 * @param source - contents of `install.sh`.
 * @returns the pins, in the order the file lists them.
 */
export function parsePinnedPlugins(source: string): PinnedPlugin[] {
  const line = SPECS_LINE.exec(source)
  if (line === null) {
    throw new Error(`${INSTALLER_PATH} has no DEFAULT_PLUGINS=(...) line`)
  }
  const tokens = (line[1] ?? '').trim().split(/\s+/).filter(token => token !== '')
  if (tokens.length === 0) {
    throw new Error(`${INSTALLER_PATH} pins no preinstalled plugins`)
  }
  return tokens.map((token) => {
    const match = SPEC_TOKEN.exec(token)
    if (match === null) {
      throw new Error(
        `${INSTALLER_PATH} pins ${JSON.stringify(token)}; a pin must be name@version, with an `
        + 'exact version (a range would install a version the release smoke did not boot)',
      )
    }
    return { name: `${match[1] ?? ''}${match[2] ?? ''}`, version: match[3] ?? '' }
  })
}

/**
 * Render pins as the installer's own token list.
 * @param plugins - pins to render.
 * @returns the space-separated specs, in order.
 */
export function serializePinnedPlugins(plugins: readonly PinnedPlugin[]): string {
  return plugins.map(plugin => `${plugin.name}@${plugin.version}`).join(' ')
}

/**
 * Replace the installer's pin line.
 * @param source - contents of `install.sh`.
 * @param plugins - pins to write.
 * @returns the installer text with its `DEFAULT_PLUGINS` line rewritten.
 */
export function withPinnedPlugins(source: string, plugins: readonly PinnedPlugin[]): string {
  // Parsed first, so a file whose line this cannot match is a loud failure
  // rather than a rewrite that silently drops a plugin.
  parsePinnedPlugins(source)
  return source.replace(SPECS_LINE, `DEFAULT_PLUGINS=(${serializePinnedPlugins(plugins)})`)
}

/**
 * The `name@version` strings the documentation is expected to quote.
 * @param plugins - pins.
 * @returns one reference per pin.
 */
export function referencesOf(plugins: readonly PinnedPlugin[]): string[] {
  return plugins.map(plugin => `${plugin.name}@${plugin.version}`)
}

/**
 * Which pins a document does not name.
 * @param document - README text.
 * @param plugins - pins the document is expected to name.
 * @returns the missing references, in pin order.
 */
export function missingReferences(
  document: string,
  plugins: readonly PinnedPlugin[],
): string[] {
  return referencesOf(plugins).filter(reference => !document.includes(reference))
}

/**
 * Rewrite a document's references from one pin set to another.
 * @param document - README text.
 * @param before - pins the document currently names.
 * @param after - pins it should name.
 * @returns the rewritten text, and whether anything changed.
 */
export function withReferences(
  document: string,
  before: readonly PinnedPlugin[],
  after: readonly PinnedPlugin[],
): { readonly text: string; readonly changed: boolean } {
  let text = document
  let changed = false
  before.forEach((plugin, index) => {
    const target = after[index]
    if (target === undefined) return
    const from = `${plugin.name}@${plugin.version}`
    const to = `${target.name}@${target.version}`
    if (from === to) return
    if (!text.includes(from)) return
    text = text.replaceAll(from, to)
    changed = true
  })
  return { text, changed }
}

/**
 * One pin that is not what the registry publishes.
 */
export interface StalePin {
  /** Package name. */
  readonly name: string
  /** Version the installer pins. */
  readonly pinned: string
  /** Version the registry calls `latest`. */
  readonly latest: string
}

/**
 * Compare pins against the versions the registry publishes.
 * @param plugins - pins.
 * @param latest - registry `latest` per package name.
 * @returns the pins that disagree, in pin order.
 */
export function stalePins(
  plugins: readonly PinnedPlugin[],
  latest: ReadonlyMap<string, string>,
): StalePin[] {
  const stale: StalePin[] = []
  for (const plugin of plugins) {
    const published = latest.get(plugin.name)
    if (published === undefined || published === plugin.version) continue
    stale.push({ name: plugin.name, pinned: plugin.version, latest: published })
  }
  return stale
}

/**
 * Read the pins of a checkout.
 * @param root - repository root.
 * @returns the pins `install.sh` installs.
 */
export function readPinnedPlugins(root: string): PinnedPlugin[] {
  return parsePinnedPlugins(readFileSync(resolve(root, INSTALLER_PATH), 'utf8'))
}

/**
 * Write pins into a checkout's installer, and into both READMEs.
 * @param root - repository root.
 * @param plugins - pins to write.
 * @returns what was rewritten.
 */
export function writePinnedPlugins(
  root: string,
  plugins: readonly PinnedPlugin[],
): { readonly installer: boolean; readonly readmes: string[] } {
  const installerPath = resolve(root, INSTALLER_PATH)
  const installerSource = readFileSync(installerPath, 'utf8')
  const before = parsePinnedPlugins(installerSource)
  const rewritten = withPinnedPlugins(installerSource, plugins)
  writeFileSync(installerPath, rewritten)

  const readmes: string[] = []
  for (const relative of README_PATHS) {
    const path = resolve(root, relative)
    const source = readFileSync(path, 'utf8')
    const { text, changed } = withReferences(source, before, plugins)
    if (!changed) continue
    writeFileSync(path, text)
    readmes.push(relative)
  }
  return { installer: rewritten !== installerSource, readmes }
}

/**
 * Ask a registry which version it calls `latest`.
 * @param name - package name, scope included.
 * @param registry - registry base URL, with or without a trailing slash.
 * @returns the published latest version.
 */
export async function latestVersion(name: string, registry: string): Promise<string> {
  const base = registry.endsWith('/') ? registry : `${registry}/`
  const url = new URL(name.startsWith('@') ? name.replace('/', '%2F') : name, base)
  let payload: unknown
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/vnd.npm.install-v1+json' },
      signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    payload = await response.json()
  } catch (error) {
    throw new Error(
      `${name}: ${base} could not be asked (${error instanceof Error ? error.message : String(error)})`,
    )
  }
  const latest = (payload as RegistryDocument)['dist-tags']?.latest
  if (typeof latest !== 'string') throw new Error(`${name}: ${base} published no latest tag`)
  return latest
}

/**
 * Ask a registry for the latest version of each pin.
 * @param plugins - pins.
 * @param registry - registry base URL.
 * @returns the published latest per package name.
 */
export async function latestVersions(
  plugins: readonly PinnedPlugin[],
  registry: string,
): Promise<Map<string, string>> {
  const entries = await Promise.all(
    plugins.map(async (plugin): Promise<[string, string]> => [
      plugin.name,
      await latestVersion(plugin.name, registry),
    ]),
  )
  return new Map(entries)
}

const USAGE = `usage: tsx scripts/happy-dsh/preinstall.ts <command> [--registry <url>]

  show              print the pins ${INSTALLER_PATH} installs
  verify            check the pins and the READMEs that name them, offline
  check             fail when a pin is not the registry's latest (CI)
  bump              set every pin to the registry's latest, and the READMEs with it
  specs             print the raw \`name@version\` specs, one per line

  --registry <url>  registry to ask (default ${DEFAULT_REGISTRY})`

/** Repository root, from this file's own location. */
const ROOT = resolve(import.meta.dirname, '..', '..')

/**
 * Read `--registry` from the arguments.
 * @param argv - arguments after the command.
 * @returns the registry base URL.
 */
function registryOf(argv: readonly string[]): string {
  const index = argv.indexOf('--registry')
  if (index === -1) return DEFAULT_REGISTRY
  const value = argv[index + 1]
  if (value === undefined) throw new Error('--registry needs a value')
  return value
}

/**
 * Run one command, reporting the pins as they change.
 * @param argv - arguments after the script path.
 * @returns the process exit code: 0 success, 1 refused, 2 usage.
 */
async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv
  try {
    switch (command) {
      case 'show': {
        for (const plugin of readPinnedPlugins(ROOT)) {
          console.log(`${plugin.name}@${plugin.version}`)
        }
        return 0
      }
      case 'specs': {
        console.log(serializePinnedPlugins(readPinnedPlugins(ROOT)))
        return 0
      }
      case 'verify': {
        const plugins = readPinnedPlugins(ROOT)
        let missing = 0
        for (const relative of README_PATHS) {
          const absent = missingReferences(readFileSync(resolve(ROOT, relative), 'utf8'), plugins)
          if (absent.length === 0) continue
          console.error(`${relative} does not name: ${absent.join(', ')}`)
          missing += absent.length
        }
        if (missing > 0) {
          console.error('run `pnpm run happy-dsh:preinstall bump` to write both')
          return 1
        }
        console.log(`preinstall pins: ${serializePinnedPlugins(plugins)} (documented)`)
        return 0
      }
      case 'check': {
        const plugins = readPinnedPlugins(ROOT)
        const stale = stalePins(plugins, await latestVersions(plugins, registryOf(rest)))
        if (stale.length === 0) {
          console.log(`preinstall pins are current: ${serializePinnedPlugins(plugins)}`)
          return 0
        }
        for (const pin of stale) {
          console.error(`${pin.name}: pinned ${pin.pinned}, registry latest ${pin.latest}`)
        }
        console.error('run `pnpm run happy-dsh:preinstall bump`, then')
        console.error('`bash deploy/release/preinstall-smoke.sh` to prove the new pair boots')
        return 1
      }
      case 'bump': {
        const before = readPinnedPlugins(ROOT)
        const latest = await latestVersions(before, registryOf(rest))
        const after = before.map(plugin => ({
          name: plugin.name,
          version: latest.get(plugin.name) ?? plugin.version,
        }))
        const stale = stalePins(before, latest)
        if (stale.length === 0) {
          console.log(`preinstall pins already current: ${serializePinnedPlugins(before)}`)
          return 0
        }
        const written = writePinnedPlugins(ROOT, after)
        for (const pin of stale) console.log(`${pin.name}: ${pin.pinned} -> ${pin.latest}`)
        console.log(`rewrote ${INSTALLER_PATH}${written.installer ? '' : ' (unchanged)'}`)
        for (const relative of written.readmes) console.log(`rewrote ${relative}`)
        console.log('next: `bash deploy/release/preinstall-smoke.sh` installs this pair and boots it')
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
    console.error(`happy-dsh preinstall: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2))
