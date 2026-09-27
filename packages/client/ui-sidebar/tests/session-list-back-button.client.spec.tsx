// @vitest-environment jsdom
/** The Conversation header's Session-list occupant on a frame that keeps no rail. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { en } from '../src/client/locales.ts'
import { SessionListBackButton, type SessionListBackButtonProps } from '../src/client/SessionListBackButton.tsx'

// English-dictionary translate stub: the occupant renders the same copy the
// assertions below query by accessible name and by visible label.
const t = ((key: string) => (en as Record<string, string>)[key] ?? key) as SessionListBackButtonProps['t']

afterEach(() => {
  cleanup()
})

describe('SessionListBackButton', () => {
  it('names its destination with the sidebar dictionary copy', () => {
    const props = { toggleSidebar: vi.fn(), t } as SessionListBackButtonProps
    render(<SessionListBackButton {...props} />)
    const control = screen.getByRole('button', { name: en['header.backToSessions'] })
    // The visible label names the same destination as the accessible name, so
    // the control reads as a navigation bar's back button rather than an icon.
    expect(control.textContent).toBe(en['header.sessions'])
  })

  it('returns to the Session list through the injected toggle', () => {
    const toggleSidebar = vi.fn()
    const props = { toggleSidebar, t } as SessionListBackButtonProps
    render(<SessionListBackButton {...props} />)
    fireEvent.click(screen.getByRole('button', { name: en['header.backToSessions'] }))
    expect(toggleSidebar).toHaveBeenCalledOnce()
  })
})
