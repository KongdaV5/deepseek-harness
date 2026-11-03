/** Running Turn clock isolated from the transcript's render cycle. */
import { memo, useEffect, useState } from 'react'
import { TextShimmer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ProcessActivity } from '../contract/process-groups.ts'
import type { ExecutionFeedback } from '../conversation-nodes/execution-feedback.ts'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import { formatRunDuration, LIVE_RUN_CLOCK_INTERVAL_MS } from './message-chrome.ts'
import { RunningWhaleTail } from './RunningWhaleTail.tsx'
import a11yCss from './accessibility.module.css'
import css from './ChatView.module.css'

interface RunningStatusProps {
  readonly startTime: number | undefined
  readonly feedback: ExecutionFeedback | undefined
  readonly t: ChatViewSlotProps['t']
}

function stageLabel(feedback: ExecutionFeedback | undefined, t: ChatViewSlotProps['t']): string {
  if (feedback === undefined) return t('chat.deepDiving')
  if (feedback.kind === 'preparing') return t('chat.preparingRequest')
  if (feedback.kind === 'waiting-local') return t('chat.waitingLocal')
  if (feedback.kind === 'retrying') return t('chat.retryingModel')
  if (feedback.kind === 'thinking') return t('message.stepProcess.thinking')
  if (feedback.kind === 'responding') return t('chat.generatingReply')
  const labels: Record<ProcessActivity, string> = {
    read: t('message.stepProcess.read'),
    readImage: t('message.stepProcess.readImage'),
    search: t('message.stepProcess.search'),
    write: t('message.stepProcess.write'),
    edit: t('message.stepProcess.edit'),
    commands: t('message.stepProcess.commands'),
    code: t('message.stepProcess.code'),
    webSearch: t('message.stepProcess.webSearch'),
    webFetch: t('message.stepProcess.webFetch'),
    subagents: t('message.stepProcess.subagents'),
    plan: t('message.stepProcess.plan'),
    questions: t('message.stepProcess.questions'),
    tools: t('message.stepProcess.tools'),
  }
  return labels[feedback.activity]
}

/**
 * Show live elapsed time after the current Turn's content without announcing ticks.
 * @param props - Current Turn start time and localized copy.
 * @returns the blue running indicator; mount only while the Session is running.
 */
export const RunningStatus = memo(function RunningStatus({ startTime, feedback, t }: RunningStatusProps) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (startTime === undefined) return
    setNow(Date.now())
    const timer = setInterval(() => { setNow(Date.now()) }, LIVE_RUN_CLOCK_INTERVAL_MS)
    return () => { clearInterval(timer) }
  }, [startTime])
  const stage = stageLabel(feedback, t)
  const label = startTime === undefined
    ? stage
    : feedback === undefined
      ? t('chat.deepDivingFor', {
        duration: formatRunDuration(Math.max(1000, now - startTime), t).map(part => part.text).join(''),
      })
      : t('chat.activityFor', {
        activity: stage,
        duration: formatRunDuration(Math.max(1000, now - startTime), t).map(part => part.text).join(''),
      })
  return (
    <div className={css.running} data-chat-running data-chat-running-stage={feedback?.kind}>
      <span className={a11yCss.visuallyHidden} role="status" aria-live="polite" aria-atomic="true">{stage}</span>
      <span className={css.runningDivider} aria-hidden="true" />
      <span className={css.runningContent}>
        <RunningWhaleTail />
        <TextShimmer active className={css.runningText}>{label}</TextShimmer>
      </span>
    </div>
  )
})
