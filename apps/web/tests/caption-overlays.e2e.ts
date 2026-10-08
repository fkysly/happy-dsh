/** Browser geometry for settings, expanded plugin dialogs, and their menus under Windows caption markers. */
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { openSettings, ZH_BROWSER_LOCALE } from './support.ts'

it('keeps settings and expanded plugin dialogs clear of the Windows caption across fullscreen transitions', async () => {
  const scaffold = await launchWebScaffold({
    profile: { packages: [] },
    extraOverlayPath: fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)),
  })
  try {
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage({ viewport: { width: 520, height: 600 }, locale: ZH_BROWSER_LOCALE })
      const console = watchConsole(page)
      await page.goto(scaffold.authenticatedUrl)
      await page.waitForSelector('[class*="frame"]')
      await page.evaluate(() => {
        document.documentElement.setAttribute('data-windows-titlebar', '')
        document.documentElement.style.setProperty('--dsh-windows-titlebar-height', '40px')
      })
      const reopenSidebar = page.getByRole('button', { name: '打开侧边栏', exact: true })
      if (await reopenSidebar.isVisible()) await reopenSidebar.click()
      await openSettings(page, 'zh')
      const settings = page.getByRole('dialog', { name: '设置', exact: true })
      const settingsMask = settings.locator('..').locator(':scope > [aria-hidden="true"]')
      // At 520px (the Desktop window's minimum width) Settings is the phone's full-screen page:
      // it starts where the caption ends and fills the rest of the window.
      for (const fullscreen of [false, true, false]) {
        await page.evaluate(value => document.documentElement.toggleAttribute('data-fullscreen', value), fullscreen)
        const captionBottom = fullscreen ? 0 : 40
        await expect.poll(async () => (await settings.boundingBox())?.y).toBe(captionBottom)
        expect((await settings.boundingBox())?.height).toBe(600 - captionBottom)
        expect((await settingsMask.boundingBox())?.y).toBe(captionBottom)
        expect((await settings.locator('..').boundingBox())?.height).toBe(600)
      }
      expect(await page.evaluate(() => document.elementFromPoint(300, 20)?.getAttribute('role'))).toBe('presentation')
      await page.mouse.click(300, 20)
      expect(await settings.isVisible()).toBe(true)
      await settings.getByRole('button', { name: '工作区内修改', exact: true }).click()
      const menu = page.getByRole('menu')
      await menu.waitFor()
      const menuRect = await menu.boundingBox()
      expect(menuRect?.y).toBeGreaterThanOrEqual(60)
      expect(menuRect!.y + menuRect!.height).toBeLessThanOrEqual(588)
      await page.keyboard.press('Escape')
      await menu.waitFor({ state: 'hidden' })
      expect(await settings.isVisible()).toBe(true)
      await settings.getByRole('button', { name: '关闭', exact: true }).click()
      if (await reopenSidebar.isVisible()) await reopenSidebar.click()
      await page.getByRole('navigation', { name: '全局面板' }).getByRole('button', { name: '插件', exact: true }).click()
      // A 520px frame shows the expanded sidebar as a full-frame drawer, which choosing a global panel leaves
      // open (ui-layout's known limitation); the sidebar's own collapse control closes it.
      const scrim = page.locator('[data-sidebar-scrim]')
      if (await scrim.isVisible()) {
        await page.getByRole('button', { name: '收起侧边栏', exact: true }).click()
        await scrim.waitFor({ state: 'detached' })
      }
      await page.locator('[data-plugin-panel]').getByRole('button', { name: '添加插件', exact: true }).click()
      const plugin = page.getByRole('dialog', { name: '添加插件', exact: true })
      await plugin.getByRole('button', { name: '插件安装引导和示例', exact: true }).click()
      await expect.poll(() => plugin.locator('button[aria-expanded="true"]').count()).toBe(1)
      for (const fullscreen of [false, true, false]) {
        await page.evaluate(value => document.documentElement.toggleAttribute('data-fullscreen', value), fullscreen)
        const margin = fullscreen ? 24 : 60
        // The dialog is content-sized: it fills the available height only while its content needs it,
        // and otherwise stays centered inside the same clearances.
        await expect.poll(async () => {
          const box = await plugin.boundingBox()
          return box !== null && box.y >= margin && box.y + box.height <= 600 - margin
        }, { timeout: 5_000 }).toBe(true)
        expect((await plugin.locator('..').locator(':scope > [aria-hidden="true"]').boundingBox())?.y).toBe(fullscreen ? 0 : 40)
        expect(await plugin.getByRole('button', { name: '关闭', exact: true }).isVisible()).toBe(true)
        expect(await plugin.getByRole('button', { name: '安装', exact: true }).isVisible()).toBe(true)
      }
      await plugin.getByRole('button', { name: /^安装源/ }).click()
      const registry = page.locator('[data-install-registry]')
      await registry.waitFor()
      const registryRect = await registry.boundingBox()
      expect(registryRect!.y).toBeGreaterThanOrEqual(60)
      expect(registryRect!.y + registryRect!.height).toBeLessThanOrEqual(588)
      await page.keyboard.press('Escape')
      await registry.waitFor({ state: 'hidden' })
      expect(await plugin.isVisible()).toBe(true)
      await page.keyboard.press('Escape')
      await plugin.waitFor({ state: 'hidden' })
      for (const platform of ['darwin', 'browser']) {
        await page.evaluate((value) => {
          document.documentElement.removeAttribute('data-windows-titlebar')
          document.documentElement.removeAttribute('data-fullscreen')
          if (value === 'darwin') document.documentElement.setAttribute('data-platform', value)
          else document.documentElement.removeAttribute('data-platform')
        }, platform)
        // The frame re-renders for the new platform after these attribute edits,
        // so name the control that platform offers rather than whichever one was
        // visible a moment before: on macOS a narrow frame's sidebar opens from
        // the window-chrome seat; a plain browser reaches Settings through the
        // Session list, which openSettings opens itself.
        if (platform === 'darwin') {
          await page.locator('[data-shell-leading]').getByRole('button', { name: '打开侧边栏', exact: true }).click()
        }
        await openSettings(page, 'zh')
        await expect.poll(async () => (await settings.boundingBox())?.y).toBe(0)
        expect((await settingsMask.boundingBox())?.y).toBe(0)
        // The macOS window strip (48px, traffic lights) stays clear of the page's title.
        const title = settings.locator(`[id="${await settings.getAttribute('aria-labelledby')}"]`)
        expect((await title.boundingBox())!.y).toBeGreaterThanOrEqual(platform === 'darwin' ? 48 : 0)
        await page.keyboard.press('Escape')
        await settings.waitFor({ state: 'hidden' })
      }
      expect(console.pageErrors).toEqual([])
      expect(console.warnings).toEqual([])
    } finally { await browser.close() }
  } finally { await scaffold.close() }
})
