/** Connection feedback shared by every surface that shows the link's state. */
import { useLayoutEffect, useRef, useState } from 'react'
import type { ConnectionIndicatorState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConnectionState } from '@deepseek-ai/dsh-client-connection/client'

/** How long the recovered confirmation stays after the link returns. */
const RECOVERY_CONFIRMATION_MS = 2_000

/** Minimum visible time for the connecting state; shorter attempts read as flicker. */
const CONNECTING_MIN_VISIBLE_MS = 800

/**
 * Derive what a connection indicator shows from the live connection state.
 *
 * A connecting attempt stays visible for at least {@link CONNECTING_MIN_VISIBLE_MS},
 * and a return from an outage or an attempt shows a recovered confirmation for
 * {@link RECOVERY_CONFIRMATION_MS}. Every surface that shows the state derives it
 * here, so the settings footer and the Conversation header never disagree about
 * timing.
 * @param connectionState - the connection's current state; undefined before the first report.
 * @returns the indicator state to render, or undefined when there is nothing to report.
 */
export function useConnectionFeedback(connectionState: ConnectionState | undefined): ConnectionIndicatorState | undefined {
  const [showRecovery, setShowRecovery] = useState(false)
  const [holdConnecting, setHoldConnecting] = useState(false)
  const connectingShownAt = useRef<number | undefined>(undefined)
  const previousConnectionState = useRef(connectionState)

  useLayoutEffect(() => {
    const previous = previousConnectionState.current
    previousConnectionState.current = connectionState
    if (connectionState !== 'connected') {
      setShowRecovery(false)
      return
    }
    if (previous !== 'disconnected' && previous !== 'connecting') return
    setShowRecovery(true)
  }, [connectionState])

  // The confirmation window starts when the recovered state becomes visible,
  // which the connecting minimum-visible hold can delay past the transition.
  useLayoutEffect(() => {
    if (!showRecovery || holdConnecting) return
    const timeout = window.setTimeout(() => { setShowRecovery(false) }, RECOVERY_CONFIRMATION_MS)
    return () => { window.clearTimeout(timeout) }
  }, [showRecovery, holdConnecting])

  useLayoutEffect(() => {
    if (connectionState === 'connecting') {
      connectingShownAt.current = Date.now()
      return
    }
    const shownAt = connectingShownAt.current
    if (shownAt === undefined) return
    connectingShownAt.current = undefined
    const remaining = CONNECTING_MIN_VISIBLE_MS - (Date.now() - shownAt)
    if (remaining <= 0) return
    setHoldConnecting(true)
    const timeout = window.setTimeout(() => { setHoldConnecting(false) }, remaining)
    return () => {
      window.clearTimeout(timeout)
      setHoldConnecting(false)
    }
  }, [connectionState])

  if (connectionState === 'connecting' || holdConnecting) return 'connecting'
  if (connectionState === 'disconnected') return 'disconnected'
  if (showRecovery) return 'recovered'
  return undefined
}
