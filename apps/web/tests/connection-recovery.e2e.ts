/** Real WebSocket loss without replacing Client plugins or navigating the page. */
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { chromium, devices, type WebSocketRoute } from 'playwright'
import { expect, it, onTestFailed, onTestFinished } from 'vitest'
import { launchWebScaffold, seedSession, watchConsole } from './scaffold.ts'
import { newEnglishPage, saveFailureShot, writeComposerDraft } from './support.ts'

it.each([false, true])('retains the mounted application across WebSocket recovery with an active Session: %s', async (activeSession) => {
  const scaffold = await launchWebScaffold({
    extraOverlayPath: fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)),
  })
  onTestFinished(() => scaffold.close())
  const title = 'Connection recovery session'
  const draft = 'Unsent draft retained across connection recovery'
  if (activeSession) {
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const seed = fileURLToPath(new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url))
    const sessionId = await seedSession(scaffold, await readFile(seed, 'utf8'), 'connection-recovery-session')
    await workspace.attachSession(sessionId)
    await scaffold.ctx.sessionController.rename({ sessionId, title })
  }
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  const console = watchConsole(page)
  onTestFailed(() => saveFailureShot(page, 'web-e2e-connection-recovery'))
  const sockets: { client: WebSocketRoute; server: WebSocketRoute }[] = []
  let readyFrames = 0
  let sessionBaselines = 0
  await page.routeWebSocket('**/api/remote.mux', (client) => {
    const server = client.connectToServer()
    sockets.push({ client, server })
    const endpoints = new Map<string, string>()
    client.onMessage((message) => {
      if (typeof message === 'string') {
        const frame = JSON.parse(message) as { type?: string; streamId: string; endpoint: string }
        if (frame.type === 'open') endpoints.set(frame.streamId, frame.endpoint)
      }
      server.send(message)
    })
    server.onMessage((message) => {
      if (typeof message === 'string') {
        const frame = JSON.parse(message) as { type?: string; streamId: string; value?: { type?: string } }
        if (frame.type === 'item' && frame.value?.type === 'ready') readyFrames++
        if (frame.type === 'item' && endpoints.get(frame.streamId) === 'session/follow'
          && frame.value?.type === 'snapshot') sessionBaselines++
      }
      client.send(message)
    })
  })
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  const composer = page.locator('[data-composer-input][contenteditable="true"]')
  if (activeSession) {
    await page.getByRole('treeitem').filter({ has: page.getByText(title, { exact: true }) }).click({ timeout: 20_000 })
    await writeComposerDraft(page, composer, draft)
    await expect.poll(() => sessionBaselines).toBeGreaterThan(0)
  } else {
    await page.getByText('Into the Unknown', { exact: true }).waitFor({ timeout: 20_000 })
  }
  await expect.poll(() => readyFrames).toBeGreaterThan(0)
  const root = await page.locator('[data-slot="root"]').elementHandle()
  expect(root).not.toBeNull()
  let navigations = 0
  page.on('framenavigated', () => { navigations++ })

  for (let attempt = 0; attempt < 3; attempt++) {
    const previousReady = readyFrames
    const previousBaseline = sessionBaselines
    const active = sockets.at(-1)!
    await Promise.all([
      active.client.close({ code: 1012, reason: 'test connection loss' }),
      active.server.close({ code: 1012, reason: 'test connection loss' }),
    ])
    await expect.poll(() => readyFrames, { timeout: 20_000 }).toBeGreaterThan(previousReady)
    if (activeSession) {
      await expect.poll(() => sessionBaselines, { timeout: 20_000 }).toBeGreaterThan(previousBaseline)
    }
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => { requestAnimationFrame(() => { resolve() }) })
    }))
    expect(await root!.evaluate(element => element.isConnected)).toBe(true)
    expect(console.pageErrors).toEqual([])
    if (activeSession) expect(await composer.textContent()).toBe(draft)
  }

  expect(navigations).toBe(0)
  if (!activeSession) expect(await page.getByText('Into the Unknown', { exact: true }).isVisible()).toBe(true)
})

it('shows the outage on a phone without opening the drawer, and recovers through it', async () => {
  const scaffold = await launchWebScaffold({})
  onTestFinished(() => scaffold.close())
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  // A phone keeps the sidebar as a closed drawer, so the expanded row's
  // connection indicator is never on screen: the state has to reach the
  // always-visible rail, as a 44-point target of its own.
  const context = await browser.newContext({ ...devices['iPhone 13'], locale: 'en-US' })
  onTestFinished(() => context.close())
  const page = await context.newPage()
  const console = watchConsole(page)
  onTestFailed(() => saveFailureShot(page, 'web-e2e-connection-recovery-phone'))
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await page.getByRole('button', { name: 'Open sidebar' }).first().waitFor({ timeout: 30_000 })
  const outage = page.getByRole('button', { name: /^Disconnected/ })
  await expect.poll(() => outage.count(), { timeout: 5_000 }).toBe(0)

  await context.setOffline(true)
  await expect.poll(() => outage.count(), { timeout: 20_000 }).toBe(1)
  // The drawer stayed closed: the control is on screen because the rail is,
  // not because a surface was opened for it.
  expect(await page.getByRole('button', { name: 'Open sidebar' }).count()).toBe(1)
  const report = await outage.evaluate((control) => {
    const rect = control.getBoundingClientRect()
    const cx = rect.x + rect.width / 2
    const cy = rect.y + rect.height / 2
    const reaches = (x: number, y: number): boolean => {
      const hit = document.elementFromPoint(x, y)
      return hit !== null && (hit === control || control.contains(hit))
    }
    const samples: [number, number][] = [
      [cx, cy], [cx, rect.y + 1], [cx, rect.bottom - 1], [rect.x + 1, cy], [rect.right - 1, cy],
    ]
    return {
      drawn: [Math.round(rect.width), Math.round(rect.height)] as const,
      misses: samples.filter(([x, y]) => !reaches(x, y)).length,
    }
  })
  expect(report.drawn[0]).toBeGreaterThanOrEqual(44)
  expect(report.drawn[1]).toBeGreaterThanOrEqual(44)
  expect(report.misses).toBe(0)

  await outage.click()
  await expect.poll(() => page.getByRole('button', { name: /^Reconnecting/ }).count(), { timeout: 20_000 }).toBe(1)

  await context.setOffline(false)
  await expect.poll(() => page.getByRole('status', { name: 'Connected' }).count(), { timeout: 30_000 }).toBe(1)
  // The confirmation is transient: the rail returns to carrying only controls.
  await expect.poll(() => page.getByRole('status', { name: 'Connected' }).count(), { timeout: 15_000 }).toBe(0)
  expect(console.pageErrors).toEqual([])
}, 120_000)
