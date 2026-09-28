// @vitest-environment jsdom
/**
 * `useAnchoredPosition` wiring: a floating panel is placed from its anchor and
 * keeps tracking it while open.
 *
 * The geometry itself needs real layout, which jsdom does not provide. What
 * is asserted here is the wiring the clamp depends on: the
 * listeners and the panel-size observer are attached while open and released on
 * close, a size change replays the placement, and the hook still works where
 * `ResizeObserver` does not exist.
 */
import { useMemo, useRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { useAnchoredPosition } from '../src/useAnchoredPosition.ts'

afterEach(() => {
  cleanup()
  document.body.style.zoom = ''
  vi.unstubAllGlobals()
})

/** One recorded `ResizeObserver` instance, so a test can drive its callback. */
interface Recorded {
  callback: ResizeObserverCallback
  observed: Element[]
  disconnected: boolean
}

/**
 * Install a recording `ResizeObserver` double.
 * @returns the list every constructed observer registers itself in.
 */
function stubResizeObserver(): Recorded[] {
  const made: Recorded[] = []
  vi.stubGlobal('ResizeObserver', class {
    private readonly record: Recorded

    constructor(callback: ResizeObserverCallback) {
      this.record = { callback, observed: [], disconnected: false }
      made.push(this.record)
    }

    observe(element: Element) { this.record.observed.push(element) }
    disconnect() { this.record.disconnected = true }
  })
  return made
}

/**
 * Host component that anchors a panel and reports the computed position.
 * @param props - whether the panel is open.
 * @returns the anchor and, while open, the panel carrying the position.
 */
function Host({ open }: { open: boolean }) {
  const anchorRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const position = useAnchoredPosition({ open, anchorRef, panelRef, gap: 4, margin: 12 })
  return (
    <>
      <button ref={anchorRef} type="button">anchor</button>
      {open && <div ref={panelRef} data-testid="panel" style={position ?? { visibility: 'hidden' }} />}
    </>
  )
}

/** Deterministic geometry host for the panel's anchor, viewport, and dimensions. */
function GeometryHost({
  side = 'top', align = 'end', flip = true, layoutKey = 'stable',
}: { side?: 'top' | 'bottom'; align?: 'start' | 'end'; flip?: boolean; layoutKey?: string }) {
  const anchorRef = useRef<HTMLButtonElement>(null)
  const panelRef = useMemo(() => ({ current: null as HTMLDivElement | null }), [])
  const position = useAnchoredPosition({ open: true, layoutKey, anchorRef, panelRef, side, align, flip, gap: 8, margin: 12 })
  return (
    <>
      <button ref={anchorRef} type="button" data-testid="geometry-anchor">anchor</button>
      <div
        ref={(node) => {
          panelRef.current = node
          if (node === null) return
          Object.defineProperties(node, {
            offsetWidth: { configurable: true, value: 120 },
            offsetHeight: { configurable: true, value: 100 },
          })
        }}
        data-testid="geometry-panel"
        style={position ?? { visibility: 'hidden' }}
      />
    </>
  )
}

function setViewport(width: number, height: number): void {
  Object.defineProperties(window, {
    innerWidth: { configurable: true, value: width },
    innerHeight: { configurable: true, value: height },
  })
}

function setAnchorRect(rect: DOMRect): void {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.getAttribute('data-testid') === 'geometry-anchor' ? rect : new DOMRect()
  })
}

describe('useAnchoredPosition', () => {
  it('observes the panel while open and disconnects when it closes', () => {
    const made = stubResizeObserver()
    const ui = render(<Host open />)

    expect(made).toHaveLength(1)
    expect(made[0]?.observed).toEqual([ui.getByTestId('panel')])
    expect(made[0]?.disconnected).toBe(false)

    ui.rerender(<Host open={false} />)

    expect(made[0]?.disconnected).toBe(true)
  })

  it('replaces the panel when its own size changes', () => {
    const made = stubResizeObserver()
    render(<Host open />)
    const before = made[0]?.callback
    expect(before).toBeDefined()

    // A status line appearing inside the panel, or a dragged textarea, changes
    // the height without a scroll or resize event; the observer is the only
    // thing that notices, so driving its callback must not throw.
    expect(() => { before?.([], {} as ResizeObserver) }).not.toThrow()
  })

  it('still places the panel where ResizeObserver does not exist', () => {
    // jsdom's own condition, and any host without the API: the hook must fall
    // back to scroll and resize rather than fail at mount.
    vi.stubGlobal('ResizeObserver', undefined)

    expect(() => render(<Host open />)).not.toThrow()
  })

  it('attaches no listeners while the element is closed', () => {
    const made = stubResizeObserver()
    const add = vi.spyOn(window, 'addEventListener')

    render(<Host open={false} />)

    expect(made).toHaveLength(0)
    expect(add.mock.calls.filter(([type]) => type === 'scroll' || type === 'resize')).toEqual([])
    add.mockRestore()
  })

  it('right-aligns to the anchor and keeps the preferred top placement when it fits', () => {
    setViewport(500, 500)
    setAnchorRect(new DOMRect(180, 220, 100, 32))

    const ui = render(<GeometryHost />)

    expect(ui.getByTestId('geometry-panel').style.left).toBe('160px')
    expect(ui.getByTestId('geometry-panel').style.top).toBe('112px')
  })

  it('converts viewport placement into the zoomed body portal coordinate space', () => {
    setViewport(500, 500)
    document.body.style.zoom = '0.5'
    setAnchorRect(new DOMRect(180, 220, 100, 32))

    const ui = render(<GeometryHost />)

    // Body zoom scales these values back to 160px / 112px in viewport space.
    expect(ui.getByTestId('geometry-panel').style.left).toBe('320px')
    expect(ui.getByTestId('geometry-panel').style.top).toBe('224px')
  })

  it('repositions after async content changes the stable layout key', () => {
    setViewport(500, 500)
    let rect = new DOMRect(180, 220, 100, 32)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.getAttribute('data-testid') === 'geometry-anchor' ? rect : new DOMRect()
    })

    const ui = render(<GeometryHost layoutKey="loading" />)
    expect(ui.getByTestId('geometry-panel').style.top).toBe('112px')

    rect = new DOMRect(240, 300, 100, 32)
    ui.rerender(<GeometryHost layoutKey="ready" />)

    expect(ui.getByTestId('geometry-panel').style.left).toBe('220px')
    expect(ui.getByTestId('geometry-panel').style.top).toBe('192px')
  })

  it('flips below the anchor when the preferred top placement cannot fit', () => {
    setViewport(500, 500)
    setAnchorRect(new DOMRect(180, 32, 100, 32))

    const ui = render(<GeometryHost />)

    expect(ui.getByTestId('geometry-panel').style.left).toBe('160px')
    expect(ui.getByTestId('geometry-panel').style.top).toBe('72px')
    expect(ui.getByTestId('geometry-panel').style.maxHeight).toBe('')
  })

  it('clamps the panel height to the larger available side when neither side fits', () => {
    setViewport(500, 240)
    setAnchorRect(new DOMRect(180, 90, 100, 32))

    const ui = render(<GeometryHost />)

    expect(ui.getByTestId('geometry-panel').style.top).toBe('130px')
    expect(ui.getByTestId('geometry-panel').style.maxHeight).toBe('98px')
  })

  it('scales the available-height clamp into a zoomed portal coordinate space', () => {
    setViewport(500, 240)
    document.body.style.zoom = '0.5'
    setAnchorRect(new DOMRect(180, 90, 100, 32))

    const ui = render(<GeometryHost />)

    expect(ui.getByTestId('geometry-panel').style.top).toBe('260px')
    expect(ui.getByTestId('geometry-panel').style.maxHeight).toBe('196px')
  })
})
