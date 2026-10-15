import type { Context } from '@deepseek-ai/cordis'
import type {
  ConversationMatch, ConversationNodeContext, ConversationNodeDefinition, TurnInterruptedNode,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { CHAT_SYNTHETIC_SEQ_OFFSETS, chatNode } from './common.ts'

declare module '../contract/chat-nodes.ts' {
  interface ChatNodeDataMap {
    /** Turn the service stopped by restarting. */
    'turn-interrupted': TurnInterruptedNode
  }
}

interface TurnInterruptedState {
  readonly turn: number
  readonly seq: number
  readonly time: number
}

function lastStep(context: ConversationNodeContext<TurnInterruptedState>): number {
  const location = context.start?.location ?? context.matches[0]?.location
  if (location?.kind !== 'turn' && location?.kind !== 'step') return 0
  return location.turn.steps.at(-1)?.step ?? 0
}

/**
 * Anchor the notice between the closing Assistant and the turn-tail so the
 * tail stays the turn's last Chat node and keeps its branch action enabled.
 * Without a closing text Assistant there is no branch action to protect, and
 * the turn/end seq keeps the notice at the interruption point.
 */
function noticeAnchor(context: ConversationNodeContext<TurnInterruptedState>, seq: number): number {
  const location = context.start?.location ?? context.matches[0]?.location
  if (location?.kind !== 'turn' && location?.kind !== 'step') return seq
  const closing = location.turn.data.get('turn-tail')?.closing
  return closing === null || closing === undefined
    ? seq
    : closing.finalNode.seq + CHAT_SYNTHETIC_SEQ_OFFSETS.interruptedNotice
}

function stateFrom(match: ConversationMatch): TurnInterruptedState | undefined {
  if (match.event.type !== 'turn/end' || match.event.data.reason.kind !== 'interrupted') return undefined
  return { turn: match.event.data.turn, seq: match.event.seq, time: match.event.time }
}

/** Notice Definition for a turn the service stopped by restarting. */
export const turnInterruptedDefinition: ConversationNodeDefinition<TurnInterruptedState> = {
  kind: 'turn-interrupted',
  target: 'chat',
  match: (event) => {
    if (event.type === 'turn/end' && event.data.reason.kind === 'interrupted') {
      return { id: String(event.data.turn), role: 'start' }
    }
    return null
  },
  start: (_context, match) => {
    const state = stateFrom(match)
    if (state === undefined) throw new Error('turn-interrupted start requires an interrupted turn/end')
    return state
  },
  update: context => context.state,
  buildViewNode: (context) => {
    const state = context.state
    if (state === undefined) return null
    const node: TurnInterruptedNode = {
      kind: 'turn-interrupted',
      seq: state.seq,
      time: state.time,
      turn: state.turn,
      step: lastStep(context),
    }
    return chatNode(context, 'turn-interrupted', noticeAnchor(context, state.seq), node)
  },
}

/**
 * Register the interrupted turn-end notice contribution.
 * @param ctx - owning UI Conversation context.
 */
export function registerTurnInterruptedConversationNode(ctx: Context): void {
  ctx.uiConversation.events.register(turnInterruptedDefinition)
}
