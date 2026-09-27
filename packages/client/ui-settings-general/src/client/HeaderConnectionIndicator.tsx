/** The Conversation header's connection indicator, for a frame with no rail. */
import { ConnectionIndicator } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the header status seat declared by the sidebar.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { SettingsRootInjected } from './shell-contract.ts'
import { useConnectionFeedback } from './connection-feedback.ts'
import css from './HeaderConnectionIndicator.module.css'

/** Full props of the Conversation header's connection occupant. */
export type HeaderConnectionIndicatorProps =
  PropsRuntime<'sidebar.header.status'>
  & Pick<InjectFace<SettingsRootInjected>, 'useConnectionState' | 'reconnect'>
  & PropsLocale<'settings'>

/**
 * Show an outage in the Conversation header when no rail can carry it.
 *
 * A phone keeps the Session list as a closed screen, so the settings footer's
 * status line is off screen exactly when an outage matters. The header then
 * carries the compact indicator beside the Session-list control, with the same
 * timing the footer uses. The stylesheet shows it only under the frame's narrow,
 * closed-sidebar marker, so the state is never shown twice.
 * @param props - Injected connection state and reconnect action plus the settings locale seat.
 * @returns the compact indicator wrapped in its visibility seat.
 */
export function HeaderConnectionIndicator({ useConnectionState, reconnect, t }: HeaderConnectionIndicatorProps) {
  const state = useConnectionFeedback(useConnectionState(value => value))
  return (
    <span className={css.seat}>
      <ConnectionIndicator
        state={state}
        compact
        disconnectedLabel={t('connection.error')}
        connectingLabel={t('connection.connecting')}
        recoveredLabel={t('connection.connected')}
        reconnectActionLabel={t('connection.reconnect')}
        restartActionLabel={t('connection.restart')}
        onReconnect={reconnect}
      />
    </span>
  )
}
