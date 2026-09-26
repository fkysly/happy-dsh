/** `goal` namespace dictionaries. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'phase.active': '进行中的目标',
  'phase.active.disarmed': '未运行的目标',
  'phase.paused': '已暂停的目标',
  'phase.blocked': '受阻的目标',
  'reason.label': '受阻原因：{message}',
  'objective.aria': '目标内容',
  'commandInput.aria': '指令输入',
  'action.save': '保存目标',
  'action.cancel': '取消编辑',
  'action.pause': '暂停目标',
  'action.resume': '恢复目标',
  'action.edit': '编辑目标',
  'action.clear': '清除目标',
  'clear.title': '清除这个目标？',
  'clear.description': '「{objective}」以及它的轮次记录会被移除，且无法撤销。',
  'clear.confirm': '清除目标',
  'clear.keep': '保留目标',
  'clear.dismiss': '关闭',
} satisfies Record<string, string>

/** The goal namespace key union. */
export type GoalKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'phase.active': 'Ongoing Goal',
  'phase.active.disarmed': 'Inactive Goal',
  'phase.paused': 'Paused Goal',
  'phase.blocked': 'Blocked Goal',
  'reason.label': 'Blocker: {message}',
  'objective.aria': 'Goal objective',
  'commandInput.aria': 'Command input',
  'action.save': 'Save goal',
  'action.cancel': 'Cancel edit',
  'action.pause': 'Pause goal',
  'action.resume': 'Resume goal',
  'action.edit': 'Edit goal',
  'action.clear': 'Clear goal',
  'clear.title': 'Clear this goal?',
  'clear.description': 'This removes "{objective}" and its round history, and cannot be undone.',
  'clear.confirm': 'Clear goal',
  'clear.keep': 'Keep goal',
  'clear.dismiss': 'Close',
} satisfies Record<GoalKey, string>
