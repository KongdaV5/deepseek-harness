// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { DshMascotMark } from '../src/DSHMascotMark.tsx'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('DshMascotMark', () => {
  it('reacts to composer, send, new-session, stop, and navigation actions', () => {
    const view = render(
      <>
        <DshMascotMark size={24} />
        <textarea aria-label="Message" data-composer-input />
        <button aria-label="Send message" data-dsh-mascot-action="send">Send</button>
        <button aria-label="New session" data-dsh-mascot-action="new-session">New session</button>
        <button aria-label="Stop run" data-dsh-mascot-action="stop">Stop</button>
        <button aria-label="Open settings">Settings</button>
      </>,
    )
    const mood = () => view.container.querySelector('[data-dsh-mascot]')?.getAttribute('data-dsh-mascot-mood')
    const composer = view.getByLabelText('Message')

    fireEvent.focusIn(composer)
    expect(mood()).toBe('listening')
    fireEvent.input(composer, { target: { value: 'hello' } })
    expect(mood()).toBe('typing')
    fireEvent.keyDown(composer, { key: 'Enter' })
    expect(mood()).toBe('sending')
    fireEvent.click(view.getByRole('button', { name: 'New session' }))
    expect(mood()).toBe('new-session')
    fireEvent.click(view.getByRole('button', { name: 'Stop run' }))
    expect(mood()).toBe('stopping')
    fireEvent.click(view.getByRole('button', { name: 'Open settings' }))
    expect(mood()).toBe('curious')
  })

  it('reacts when the mark itself is hovered, followed, and pressed', () => {
    const view = render(<DshMascotMark size={44} />)
    const mascot = view.container.querySelector<SVGSVGElement>('[data-dsh-mascot]')!
    const mood = () => mascot.getAttribute('data-dsh-mascot-mood')
    vi.spyOn(mascot, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 44, bottom: 44, width: 44, height: 44,
      toJSON: () => ({}),
    })

    fireEvent.pointerEnter(mascot)
    expect(mood()).toBe('curious')
    fireEvent.pointerMove(mascot, { clientX: 42, clientY: 30 })
    expect(Number.parseFloat(mascot.style.getPropertyValue('--dsh-mascot-gaze-x'))).toBeCloseTo(1.45, 2)
    expect(Number.parseFloat(mascot.style.getPropertyValue('--dsh-mascot-gaze-y'))).toBeCloseTo(0.36, 2)
    fireEvent.pointerDown(mascot)
    expect(mood()).toBe('happy')
    fireEvent.pointerLeave(mascot)
    expect(mascot.style.getPropertyValue('--dsh-mascot-gaze-x')).toBe('0px')
    fireEvent.click(mascot)
    expect(mood()).toBe('happy')
  })

  it('cycles through varied idle gestures without another user action', () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const view = render(<DshMascotMark size={44} />)
    const mood = () => view.container.querySelector('[data-dsh-mascot]')?.getAttribute('data-dsh-mascot-mood')

    act(() => { vi.advanceTimersByTime(2_099) })
    expect(mood()).toBe('idle')
    act(() => { vi.advanceTimersByTime(1) })
    expect(mood()).toBe('idle-blink')
    act(() => { vi.advanceTimersByTime(1_500) })
    expect(mood()).toBe('idle')
    act(() => { vi.advanceTimersByTime(2_100) })
    expect(mood()).toBe('idle-look')
  })

  it('includes playful wave, dance, bounce, and morph gestures in idle presets', () => {
    vi.useFakeTimers()
    const expectedMoods = ['idle-blink', 'idle-look', 'idle-nod', 'idle-peek', 'idle-stretch', 'idle-wiggle', 'idle-squish', 'idle-bounce', 'idle-dance', 'idle-wave', 'idle-yawn']
    let randomCall = 0
    let previousMood: string | undefined
    let gestureIndex = 0
    vi.spyOn(Math, 'random').mockImplementation(() => {
      if (randomCall++ % 2 === 0) return 0
      const available = expectedMoods.filter(candidate => candidate !== previousMood)
      const nextMood = expectedMoods[gestureIndex++] ?? 'idle-blink'
      const selectedIndex = available.indexOf(nextMood)
      previousMood = nextMood
      return (selectedIndex + 0.01) / available.length
    })
    const view = render(<DshMascotMark size={44} />)
    const mascot = view.container.querySelector<SVGSVGElement>('[data-dsh-mascot]')!
    const mood = () => mascot.getAttribute('data-dsh-mascot-mood')

    for (const expected of expectedMoods) {
      act(() => { vi.advanceTimersByTime(2_100) })
      expect(mood()).toBe(expected)
      act(() => { vi.advanceTimersByTime(1_500) })
      expect(mood()).toBe('idle')
    }
    expect(mascot.querySelector('g[class*="arms"]')).not.toBeNull()
    expect(mascot.querySelector('ellipse[class*="yawn"]')).not.toBeNull()
  })

  it('does not animate or schedule idle reactions when reduced motion is requested', () => {
    vi.useFakeTimers()
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }) as unknown as MediaQueryList))
    const view = render(
      <>
        <DshMascotMark size={24} />
        <button aria-label="Send message" data-dsh-mascot-action="send">Send</button>
      </>,
    )
    const mood = () => view.container.querySelector('[data-dsh-mascot]')?.getAttribute('data-dsh-mascot-mood')

    fireEvent.click(view.getByRole('button', { name: 'Send message' }))
    act(() => { vi.advanceTimersByTime(30_000) })
    expect(mood()).toBe('idle')
  })
})
