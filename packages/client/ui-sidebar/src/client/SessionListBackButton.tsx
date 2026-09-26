/** The Session-list control for a Conversation header on a frame with no rail. */
import {
  IconChevronLeftOutlineRegular, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the Conversation header's leading slot declaration.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SidebarRootInjected } from './contract/slots.ts'
import css from './SessionListBackButton.module.css'

/** Full props of the Conversation header's leading occupant. */
export type SessionListBackButtonProps =
  PropsRuntime<'conversation.header.leading'>
  & InjectFace<SidebarRootInjected>
  & PropsLocale<'sidebar'>

/**
 * Navigate back to the Session list from a Conversation.
 *
 * On a frame with no room for the sidebar beside the Conversation the list is
 * a screen rather than a column, so the header owns the only control that
 * reaches it — the same job a navigation bar's back button does. The stylesheet
 * shows it only under the frame's narrow marker: a wide frame keeps the list
 * beside the Conversation and the header's leading seat stays free.
 * @param props - Injected sidebar actions plus the sidebar locale seat.
 * @returns the Session-list control.
 */
export function SessionListBackButton({ toggleSidebar, t }: SessionListBackButtonProps) {
  // Visibility is the stylesheet's decision, not a prop: the slot carries no
  // owner state, and the frame already publishes both facts the rule needs
  // (narrow, and the sidebar collapsed) as attributes on itself.
  return (
    <Tooltip label={t('header.backToSessions')} side="bottom" delayMs={500}>
      <button
        type="button"
        className={css.listButton}
        aria-label={t('header.backToSessions')}
        onClick={() => { toggleSidebar() }}
      >
        <IconChevronLeftOutlineRegular size={16} />
        <span className={css.label}>{t('header.sessions')}</span>
      </button>
    </Tooltip>
  )
}
