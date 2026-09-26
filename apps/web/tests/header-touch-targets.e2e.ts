// Touch hit areas on a phone: a Session's header buttons, view tabs, and
// message action buttons keep their drawn size but answer taps across at
// least 44 × 44 CSS px (Apple's minimum hit target), and the header's Open In
// control, which opens the workspace on the host computer, is hidden. No model
// call is involved. Hit areas are read with elementFromPoint, not synthetic
// taps: Chromium's touch emulation snaps a tap to a nearby clickable element,
// so a tap would pass without the larger area.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium, devices } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { saveFailureShot } from './support.ts'

const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/fresh-round-trip/session.v3.jsonl', import.meta.url))
const MODE = webSnapshotMode()
const SEED_ID = 'header-touch-targets-web-e2e'
const HEADER_BUTTONS = ['More actions', 'Open right sidebar']
const TABS = ['Chat', 'Trajectory']

interface HitReport {
  readonly label: string
  /** Points on a 44 × 44 box centred on the control that do not reach it. */
  readonly misses: readonly string[]
  /** Edge midpoints of the drawn control that a neighbour's area takes. */
  readonly stolen: readonly string[]
}

/**
 * Hit-test a centred 44 × 44 box and the drawn edges of each named control.
 * @param page - page showing the controls.
 * @param role - ARIA role of the controls.
 * @param labels - accessible names of the controls to test.
 * @returns one report per control, in order.
 */
function probe(page: Page, role: 'button' | 'tab', labels: readonly string[]): Promise<HitReport[]> {
  return page.evaluate(([selector, names]) => names.map((label) => {
    const control = [...document.querySelectorAll(selector)]
      .find(element => (element.getAttribute('aria-label') ?? element.textContent ?? '').trim() === label
        && element.getBoundingClientRect().width > 0)
    if (control === undefined) throw new Error(`no visible control named ${label}`)
    const rect = control.getBoundingClientRect()
    const cx = rect.x + rect.width / 2
    const cy = rect.y + rect.height / 2
    const half = 21
    const reaches = ([x, y]: readonly [number, number]): boolean => {
      const hit = document.elementFromPoint(x, y)
      return hit !== null && (hit === control || control.contains(hit))
    }
    const name = ([x, y]: readonly [number, number]): string => `${String(Math.round(x))},${String(Math.round(y))}`
    const box: [number, number][] = [
      [cx - half, cy - half], [cx + half, cy - half], [cx - half, cy + half], [cx + half, cy + half],
      [cx, cy - half], [cx, cy + half], [cx - half, cy], [cx + half, cy],
    ]
    // Edge midpoints: rounded corners are not hit-testable.
    const edges: [number, number][] = [[cx, rect.y + 1], [cx, rect.bottom - 1], [rect.x + 1, cy], [rect.right - 1, cy]]
    return {
      label,
      misses: box.filter(point => !reaches(point)).map(name),
      stolen: edges.filter(point => !reaches(point)).map(name),
    }
  }), [role === 'tab' ? '[role="tab"]' : 'button', labels] as const)
}

describe.skipIf(MODE === 'record')('web e2e: session header touch hit areas', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({
      openInAppEnvironment: createLaunchEnvironmentSnapshot([{ source: 'process', values: {} }]),
    })
    await seedSession(scaffold, await readFile(FIXTURE, 'utf8'), SEED_ID)
    browser = await chromium.launch()
    page = await browser.newPage({ ...devices['iPhone 13'], locale: 'en-US' })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.getByRole('button', { name: 'Open sidebar' }).first().click()
    const groupRow = page.locator('[role="treeitem"]').first()
    await groupRow.waitFor({ timeout: 15_000 })
    await groupRow.click()
    const sessionRow = page.locator('[role="treeitem"]').nth(1)
    await sessionRow.waitFor({ timeout: 10_000 })
    await sessionRow.click()
    await page.getByRole('tab', { name: 'Trajectory' }).waitFor({ timeout: 15_000 })
    await page.getByRole('button', { name: 'Copy' }).first().waitFor({ timeout: 15_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('lets header buttons, view tabs, and message actions answer taps across 44 × 44', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-touch-targets-header'))
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true)
    const reports = [
      ...await probe(page, 'button', HEADER_BUTTONS),
      ...await probe(page, 'tab', TABS),
      ...await probe(page, 'button', ['Copy']),
    ]
    for (const report of reports) {
      expect(report.misses, report.label).toEqual([])
      expect(report.stolen, report.label).toEqual([])
    }
    expect(tripwire.pageErrors).toEqual([])
  })

  it('hides the header control that opens the workspace in a host app', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-touch-targets-open-in'))
    expect(await page.getByRole('button', { name: 'More ways to open' }).filter({ visible: true }).count()).toBe(0)
  })
})
