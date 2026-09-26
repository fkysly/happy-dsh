import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { expect, it } from 'vitest'

const DIST_ROOT = fileURLToPath(new URL('../dist', import.meta.url))

it('ships install metadata with the built web application', async () => {
  const index = await readFile(join(DIST_ROOT, 'index.html'), 'utf8')
  expect(index).toContain('<link rel="manifest" href="./manifest.webmanifest" />')

  const manifest: unknown = JSON.parse(await readFile(join(DIST_ROOT, 'manifest.webmanifest'), 'utf8'))
  // No `id`: a browser resolves an explicit `id` against the start URL's origin,
  // so only an absent `id`, which defaults to the resolved `start_url`, gives
  // each mount its own identity. `public-mount.e2e.ts` reads the resolved form.
  // `standalone`, not `fullscreen`: iOS opens both as a Home Screen web app,
  // but only honors standalone, which Web Push and app badges require.
  expect(manifest).toEqual({
    name: 'Happy-DSH',
    short_name: 'Happy-DSH',
    start_url: './',
    scope: './',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#ffffff',
    icons: [{
      src: 'favicon.svg',
      sizes: 'any',
      type: 'image/svg+xml',
      purpose: 'any',
    }, {
      src: 'icon-512.png',
      sizes: '512x512',
      type: 'image/png',
      purpose: 'any',
    }],
  })
})

it('ships opaque PNG icons for Home Screen installers that cannot use SVG', async () => {
  const index = await readFile(join(DIST_ROOT, 'index.html'), 'utf8')
  expect(index).toContain('<link rel="apple-touch-icon" href="./apple-touch-icon.png" />')
  for (const [file, size] of [['apple-touch-icon.png', 180], ['icon-512.png', 512]] as const) {
    const png = await readFile(join(DIST_ROOT, file))
    // PNG IHDR: width and height at bytes 16–23, color type at byte 25.
    // Color type 2 is RGB with no alpha channel: Home Screen icons are opaque.
    expect({ width: png.readUInt32BE(16), height: png.readUInt32BE(20), colorType: png[25] })
      .toEqual({ width: size, height: size, colorType: 2 })
  }
})

it('lets the page reach under a notch so the shell can keep content in the safe area', async () => {
  const index = await readFile(join(DIST_ROOT, 'index.html'), 'utf8')
  expect(index).toContain('<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />')
})

it('ships fixed-color favicons selected by document media queries', async () => {
  const index = await readFile(join(DIST_ROOT, 'index.html'), 'utf8')
  expect(index).toContain('<link rel="icon" type="image/svg+xml" href="./favicon-dark.svg" media="(prefers-color-scheme: dark)" />')
  expect(index).toContain('<link rel="icon" type="image/svg+xml" href="./favicon.svg" media="(prefers-color-scheme: light)" />')
  const light = await readFile(join(DIST_ROOT, 'favicon.svg'), 'utf8')
  const dark = await readFile(join(DIST_ROOT, 'favicon-dark.svg'), 'utf8')
  expect(light).not.toContain('<style>')
  expect(light).toContain('fill="#000"')
  expect(dark).toContain('fill="#fff"')
  expect(dark.replace('fill="#fff"', 'fill="#000"')).toBe(light)
})
