/** Shell base styles stay independent from the dynamically loaded theme bundle. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const THEME_PACKAGE = '@deepseek-ai/dsh-client-ui-theme'
const baseCss = readFileSync(fileURLToPath(new URL('../src/base.css', import.meta.url)), 'utf8')

/**
 * Import specifiers of the sheet, in source order. Quote style and surrounding
 * whitespace are intentionally irrelevant; duplicate imports remain visible.
 * @param css - stylesheet text.
 * @returns import specifiers in declaration order.
 */
function importOrder(css: string): string[] {
  return [...css.matchAll(/@import\s+['"]([^'"]+)['"]/g)].map(([, specifier = '']) => specifier)
}

const imports = importOrder(baseCss)
const normalizedCss = baseCss
  .replaceAll(/\/\*[\s\S]*?\*\//g, '')
  .replaceAll(/\s+/g, ' ')
const literalContentSelectors = [
  'code',
  'pre',
  '[data-diff]',
  '[data-read]',
  '[data-search]',
  '[data-terminal]',
]

describe('web shell base.css', () => {
  it('leaves theme styles to the dynamic ui-theme client entry', () => {
    expect(imports).toEqual([])
    expect(baseCss).not.toContain(THEME_PACKAGE)
  })

  it('auto-spaces prose while preserving literal content', () => {
    expect(baseCss).toMatch(/body\s*\{[^}]*text-autospace:\s*normal;/)
    expect(normalizedCss).toContain(
      `${literalContentSelectors.join(', ')} { text-autospace: no-autospace; }`,
    )
  })

  it('keeps the mount inside the device safe area', () => {
    expect(normalizedCss).toContain(
      '#root { box-sizing: border-box; padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left); }',
    )
  })

  it('raises touch-screen text fields to 16px so focusing one does not zoom the page', () => {
    expect(normalizedCss).toContain(
      "@media (pointer: coarse) { body :is( input:not([type='checkbox'], [type='radio'], [type='range'], [type='color'], [type='file']), textarea, select, [contenteditable='true'] ) { font-size: max(16px, 1em); } }",
    )
  })
})
