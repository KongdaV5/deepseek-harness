import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import css from './DSHMascotMark.module.css'

type IdleMood =
  | 'idle-blink'
  | 'idle-look'
  | 'idle-nod'
  | 'idle-peek'
  | 'idle-stretch'
  | 'idle-wiggle'
  | 'idle-squish'
  | 'idle-bounce'
  | 'idle-dance'
  | 'idle-wave'
  | 'idle-yawn'

type MascotMood =
  | 'idle'
  | 'listening'
  | 'typing'
  | 'sending'
  | 'stopping'
  | 'new-session'
  | 'curious'
  | 'happy'
  | 'thinking'
  | IdleMood

const IDLE_MOODS: readonly IdleMood[] = [
  'idle-blink',
  'idle-look',
  'idle-nod',
  'idle-peek',
  'idle-stretch',
  'idle-wiggle',
  'idle-squish',
  'idle-bounce',
  'idle-dance',
  'idle-wave',
  'idle-yawn',
]
const IDLE_MIN_MS = 2_100
const IDLE_MAX_MS = 4_200
const REACTION_MS = 1_500

function elementOf(target: EventTarget | null): Element | null {
  return target instanceof Element ? target : null
}

function isComposer(element: Element): boolean {
  return element.closest('[data-composer-input]') !== null
}

function actionMood(element: Element): MascotMood {
  const action = element.closest('[data-dsh-mascot-action]')?.getAttribute('data-dsh-mascot-action')
  switch (action) {
    case 'new-session': return 'new-session'
    case 'stop': return 'stopping'
    case 'send': return 'sending'
    case 'success': return 'happy'
    case 'think': return 'thinking'
    default: return 'curious'
  }
}

function useMascotMood(): { mood: MascotMood; react: (nextMood: MascotMood) => void } {
  const [mood, setMood] = useState<MascotMood>('idle')
  const reactRef = useRef<(nextMood: MascotMood) => void>(() => {})

  useEffect(() => {
    let idleTimer: number | undefined
    let reactionTimer: number | undefined
    let previousIdleMood: IdleMood | undefined
    const matchMedia = (window as Partial<Window>).matchMedia
    const motionPreference = matchMedia?.call(window, '(prefers-reduced-motion: reduce)')

    const clearTimers = (): void => {
      if (idleTimer !== undefined) window.clearTimeout(idleTimer)
      if (reactionTimer !== undefined) window.clearTimeout(reactionTimer)
      idleTimer = undefined
      reactionTimer = undefined
    }
    const canAnimate = (): boolean => !(motionPreference?.matches ?? false) && !document.hidden
    const scheduleIdleReaction = (): void => {
      if (idleTimer !== undefined) window.clearTimeout(idleTimer)
      idleTimer = undefined
      if (!canAnimate()) return
      const delay = IDLE_MIN_MS + Math.floor(Math.random() * (IDLE_MAX_MS - IDLE_MIN_MS + 1))
      idleTimer = window.setTimeout(() => {
        idleTimer = undefined
        if (!canAnimate()) return
        const available = IDLE_MOODS.filter(candidate => candidate !== previousIdleMood)
        const nextMood = available[Math.floor(Math.random() * available.length)] ?? 'idle-blink'
        previousIdleMood = nextMood
        setMood(nextMood)
        reactionTimer = window.setTimeout(() => {
          reactionTimer = undefined
          setMood('idle')
          scheduleIdleReaction()
        }, REACTION_MS)
      }, delay)
    }
    const react = (nextMood: MascotMood): void => {
      clearTimers()
      if (!canAnimate()) {
        setMood('idle')
        return
      }
      setMood(nextMood)
      reactionTimer = window.setTimeout(() => {
        reactionTimer = undefined
        setMood('idle')
        scheduleIdleReaction()
      }, REACTION_MS)
    }
    reactRef.current = react

    const onClick = (event: MouseEvent): void => {
      const target = elementOf(event.target)
      if (target === null) return
      if (isComposer(target)) {
        react('listening')
        return
      }
      const action = target.closest('button, a, [role="button"]')
      if (action !== null) {
        react(actionMood(action))
        return
      }
      if (target.closest('[data-dsh-mascot]') !== null) react('happy')
    }
    const onFocusIn = (event: FocusEvent): void => {
      const target = elementOf(event.target)
      if (target === null) return
      if (isComposer(target)) react('listening')
      else if (target.closest('input, textarea, [contenteditable="true"], [role="combobox"]') !== null) {
        react('curious')
      }
    }
    const onInput = (event: Event): void => {
      const target = elementOf(event.target)
      if (target !== null && isComposer(target)) react('typing')
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = elementOf(event.target)
      if (target === null) return
      if (isComposer(target)) {
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) react('sending')
        return
      }
      if (event.key !== 'Enter' && event.key !== ' ') return
      const action = target.closest('button, [role="button"]')
      if (action !== null) react(actionMood(action))
    }
    const onSubmit = (event: Event): void => {
      const target = event.target
      if (target instanceof HTMLFormElement && target.querySelector('[data-composer-input]') !== null) {
        react('sending')
      }
    }
    const onVisibilityChange = (): void => {
      if (document.hidden) {
        clearTimers()
        setMood('idle')
      } else {
        scheduleIdleReaction()
      }
    }
    const onMotionPreferenceChange = (): void => {
      if (motionPreference?.matches) {
        clearTimers()
        setMood('idle')
      } else {
        scheduleIdleReaction()
      }
    }

    document.addEventListener('click', onClick, true)
    document.addEventListener('focusin', onFocusIn)
    document.addEventListener('input', onInput)
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('submit', onSubmit, true)
    document.addEventListener('visibilitychange', onVisibilityChange)
    motionPreference?.addEventListener('change', onMotionPreferenceChange)
    scheduleIdleReaction()
    return () => {
      clearTimers()
      reactRef.current = () => {}
      document.removeEventListener('click', onClick, true)
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('input', onInput)
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('submit', onSubmit, true)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      motionPreference?.removeEventListener('change', onMotionPreferenceChange)
    }
  }, [])

  return {
    mood,
    react: (nextMood) => {
      reactRef.current(nextMood)
    },
  }
}

function trackPointer(event: ReactPointerEvent<SVGSVGElement>): void {
  const bounds = event.currentTarget.getBoundingClientRect()
  if (bounds.width === 0 || bounds.height === 0) return
  const x = ((event.clientX - bounds.left) / bounds.width - 0.5) * 2
  const y = ((event.clientY - bounds.top) / bounds.height - 0.5) * 2
  event.currentTarget.style.setProperty('--dsh-mascot-gaze-x', `${Math.max(-1.6, Math.min(1.6, x * 1.6))}px`)
  event.currentTarget.style.setProperty('--dsh-mascot-gaze-y', `${Math.max(-1, Math.min(1, y))}px`)
}

function resetPointer(event: ReactPointerEvent<SVGSVGElement>): void {
  event.currentTarget.style.setProperty('--dsh-mascot-gaze-x', '0px')
  event.currentTarget.style.setProperty('--dsh-mascot-gaze-y', '0px')
}

/** Props for the shared DSH assistant mark. */
export interface DshMascotMarkProps {
  /** Square edge requested by the host surface. */
  size: number
  /** Optional host class added to the SVG root. */
  className?: string | undefined
}

/** Render the shared DSH robot mark with ambient and interaction-led motion.
 * @param props - Requested size and optional host class.
 * @returns A decorative SVG robot mark.
 */
export function DshMascotMark({ size, className }: DshMascotMarkProps) {
  const { mood, react } = useMascotMood()
  const classNames = className === undefined ? css.mark : `${css.mark} ${className}`

  return (
    <svg
      className={classNames}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      aria-hidden="true"
      data-dsh-mascot
      data-dsh-mascot-mood={mood}
      onPointerEnter={() => { react('curious') }}
      onPointerMove={trackPointer}
      onPointerLeave={resetPointer}
      onPointerDown={() => { react('happy') }}
      onClick={() => { react('happy') }}
    >
      <g className={css.body}>
        <path className={css.antenna} d="M32 13V7" />
        <circle className={css.signal} cx="32" cy="6" r="3.5" />
        <g className={css.arms}>
          <path className={css.armLeft} d="M10 34C5 35 4 39 6 43" />
          <circle cx="6" cy="43" r="2.2" />
          <path className={css.armRight} d="M54 34C59 35 60 39 58 43" />
          <circle cx="58" cy="43" r="2.2" />
        </g>
        <rect className={css.robotBody} x="8" y="14" width="48" height="42" rx="17" />
        <rect className={css.robotFace} x="14" y="20" width="36" height="25" rx="11" />
        <g className={css.eyes}>
          <circle cx="24" cy="30" r="2.8" />
          <circle cx="40" cy="30" r="2.8" />
        </g>
        <path className={css.robotSmile} d="M26 37c1.6 2 3.6 3 6 3s4.4-1 6-3" />
        <ellipse className={css.yawn} cx="32" cy="38" rx="3" ry="4" />
        <ellipse className={css.surprise} cx="32" cy="38" rx="2.2" ry="2.8" />
        <rect className={css.robotBadge} x="27" y="48" width="10" height="3" rx="1.5" />
      </g>
      <g className={css.sparkles} aria-hidden="true">
        <path d="M8 25v6m-3-3h6M56 19v6m-3-3h6" />
        <path d="m56 43 1.4 2.6L60 47l-2.6 1.4L56 51l-1.4-2.6L52 47l2.6-1.4z" />
      </g>
    </svg>
  )
}
