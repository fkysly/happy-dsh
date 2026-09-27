// @vitest-environment jsdom
/** The Conversation header's connection occupant on a frame that keeps no rail. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import {
  HeaderConnectionIndicator, type HeaderConnectionIndicatorProps,
} from '../src/client/HeaderConnectionIndicator.tsx'
import { en } from '../src/client/locales.ts'

type ConnectionSnapshot = Parameters<Parameters<HeaderConnectionIndicatorProps['useConnectionState']>[0]>[0]

function mount(connectionState: ConnectionSnapshot) {
  const reconnect = vi.fn()
  const props = {
    useConnectionState: select => select(connectionState),
    reconnect,
    t: makeTranslate(en),
  } as HeaderConnectionIndicatorProps
  const view = render(<HeaderConnectionIndicator {...props} />)
  return { reconnect, view }
}

afterEach(() => {
  cleanup()
})

describe('HeaderConnectionIndicator', () => {
  it('reports an outage as the compact reconnect control', () => {
    const { reconnect } = mount('disconnected')
    const control = screen.getByRole('button', { name: en['connection.reconnect'] })
    // Glyph only: the header has no room for the footer's label.
    expect(control.textContent).toBe('')
    fireEvent.click(control)
    expect(reconnect).toHaveBeenCalledOnce()
  })

  it('names a running attempt as the restart action', () => {
    mount('connecting')
    expect(screen.getByRole('button', { name: en['connection.restart'] })).toBeDefined()
  })

  it('leaves its seat empty while connected', () => {
    const { view } = mount('connected')
    expect(screen.queryByRole('button')).toBeNull()
    expect(view.container.firstElementChild?.childElementCount).toBe(0)
  })
})
