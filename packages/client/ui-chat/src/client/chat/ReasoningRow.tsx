/** Neutral progress row for an assistant thinking step. */
import { memo } from 'react'
import { IconThinkOutlineRegular, TextShimmer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import a11yCss from './accessibility.module.css'
import css from './ReasoningRow.module.css'

const THINK_ICON = <IconThinkOutlineRegular size={14} />

/**
 * Show that the assistant is thinking without displaying its private reasoning text.
 * @param props.running - whether the model is still producing this step.
 * @param props.t - conversation locale seat for status copy.
 * @returns a non-disclosing activity label.
 */
export const ReasoningRow = memo(function ReasoningRow({ running, t }: {
  running: boolean
  t: ChatViewSlotProps['t']
}) {
  const label = t('message.stepProcess.thinking')
  return (
    <div className={css.root} data-variant="think" data-state={running ? 'running' : 'ok'}>
      {running && <span className={a11yCss.visuallyHidden}>{t('row.running')}</span>}
      <div className={css.row}>
        <span className={css.leading} aria-hidden="true">{THINK_ICON}</span>
        <span className={css.title}><TextShimmer active={running}>{label}</TextShimmer></span>
      </div>
    </div>
  )
})
