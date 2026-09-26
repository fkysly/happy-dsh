// Touch hit areas on a phone: the new-session composer's toolbar buttons and
// the workspace and mode chips above it keep their drawn size but answer taps
// across at least 44 × 44 CSS px (Apple's minimum hit target). No model call
// is involved. Hit areas are read with elementFromPoint, not synthetic taps:
// Chromium's touch emulation snaps a tap to a nearby clickable element, so a
// tap would pass without the larger area.
import type { Browser, Page } from 'playwright'
import { chromium, devices } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, saveFailureShot } from './support.ts'

const MODE = webSnapshotMode()
/** Accessible-name prefixes; the selectors append their current value. */
const COMPOSER_CONTROLS = ['Add files or run commands', 'Access mode', 'Select model', 'Send message']
const HERO_CHIPS = ['Choose workspace', 'Standard mode']

interface HitReport {
  readonly label: string
  readonly drawn: readonly [number, number]
  /** Points on a 44 × 44 box centred on the control that do not reach it. */
  readonly misses: readonly string[]
  /** Edge midpoints of the drawn control that a neighbour's area takes. */
  readonly stolen: readonly string[]
}

/**
 * Hit-test a centred 44 × 44 box and the drawn edges of each named control.
 * @param page - page showing the controls.
 * @param prefixes - accessible-name prefixes of the controls to test.
 * @returns one report per control, in order.
 */
function probe(page: Page, prefixes: readonly string[]): Promise<HitReport[]> {
  return page.evaluate(names => names.map((prefix) => {
    const control = [...document.querySelectorAll('button')]
      .find(button => (button.getAttribute('aria-label') ?? button.textContent ?? '').trim().startsWith(prefix)
        && button.getBoundingClientRect().width > 0)
    if (control === undefined) throw new Error(`no visible control named ${prefix}`)
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
      label: prefix,
      drawn: [Math.round(rect.width), Math.round(rect.height)] as const,
      misses: box.filter(point => !reaches(point)).map(name),
      stolen: edges.filter(point => !reaches(point)).map(name),
    }
  }), prefixes)
}

describe.skipIf(MODE === 'record')('web e2e: composer touch hit areas', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    browser = await chromium.launch()
    page = await browser.newPage({ ...devices['iPhone 13'], locale: 'en-US' })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.getByRole('textbox', { name: 'Choose workspace' }).waitFor({ timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('gives the workspace and mode chips above an unbound composer 44 CSS px of tap height', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-touch-targets-hero-chips'))
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true)
    for (const report of await probe(page, HERO_CHIPS)) {
      // The chips are wider than 44px; the drawn height stays 28.
      expect(report.drawn[1], report.label).toBe(28)
      expect(report.misses, report.label).toEqual([])
      expect(report.stolen, report.label).toEqual([])
    }
  })

  it('lets every composer toolbar button answer taps across 44 × 44 without taking a neighbour\'s area', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-touch-targets-composer'))
    // A connected workspace enables the toolbar, and a draft enables Send.
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    await page.locator('[data-composer-input][contenteditable="true"]').fill('hello')
    for (const report of await probe(page, COMPOSER_CONTROLS)) {
      expect(report.misses, report.label).toEqual([])
      expect(report.stolen, report.label).toEqual([])
    }
    expect(tripwire.pageErrors).toEqual([])
  })
})
