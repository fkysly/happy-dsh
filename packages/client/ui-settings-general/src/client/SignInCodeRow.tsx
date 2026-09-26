/**
 * General Settings row that creates a one-time sign-in code for another
 * browser — most often the Home Screen web app, whose cookies are separate
 * from the browser's, so it cannot reuse this page's session.
 */
import { useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SignInCode } from '@deepseek-ai/dsh-client-connection/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './SignInCodeRow.module.css'

/** The Connection request supplied by the settings owner. */
export interface SignInCodeRowInjected {
  /** Resolves undefined when the Host does not require browser sign-in. */
  createSignInCode: () => Promise<SignInCode | undefined>
}

type RowState =
  | { readonly kind: 'idle' | 'creating' | 'failed' | 'unavailable' }
  | { readonly kind: 'created'; readonly code: SignInCode }

/**
 * Render the sign-in code row.
 * @param props - Connection request and localized copy.
 * @returns the General Settings row.
 */
export function SignInCodeRow({ createSignInCode, t }:
  PropsRuntime<'settings.general.item'> & PropsLocale<'settings'> & InjectFace<SignInCodeRowInjected>) {
  const [state, setState] = useState<RowState>({ kind: 'idle' })
  const [copied, setCopied] = useState(false)
  const create = (): void => {
    setState({ kind: 'creating' })
    setCopied(false)
    createSignInCode().then(
      (code) => { setState(code === undefined ? { kind: 'unavailable' } : { kind: 'created', code }) },
      () => { setState({ kind: 'failed' }) },
    )
  }
  const copy = (code: string): void => {
    void navigator.clipboard.writeText(code).then(
      () => { setCopied(true) },
      // The code stays on screen and selectable when the clipboard is refused.
      (error: unknown) => { console.warn('[settings] copying the sign-in code failed:', error) },
    )
  }
  const created = state.kind === 'created' ? state.code : undefined
  return <div className={css.row}>
    <div className={css.header}>
      <div>
        <div className={css.title}>{t('signInCode.title')}</div>
        <div className={css.description}>{t('signInCode.description')}</div>
      </div>
      <Button variant="outline" disabled={state.kind === 'creating'} onClick={create}>
        {t(state.kind === 'creating' ? 'signInCode.creating' : 'signInCode.create')}
      </Button>
    </div>
    {state.kind === 'failed' && <div className={css.message} role="alert">{t('signInCode.error')}</div>}
    {state.kind === 'unavailable' && <div className={css.message}>{t('signInCode.unavailable')}</div>}
    {created !== undefined && <div className={css.result}>
      <output className={css.code} aria-label={t('signInCode.title')}>{created.code}</output>
      <div className={css.footer}>
        <span className={css.description}>{t('signInCode.expires', {
          time: new Date(created.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        })}</span>
        <Button variant="ghost" onClick={() => { copy(created.code) }}>
          {t(copied ? 'signInCode.copied' : 'signInCode.copy')}
        </Button>
      </div>
    </div>}
  </div>
}
