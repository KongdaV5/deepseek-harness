/**
 * ModelSelect: the composer's named model seat (`conversation.input.model`).
 * One popup opens directly to the provider-grouped model list. A segmented
 * tab strip switches to the current model's effort levels and execution
 * presets without leaving that popup. The trigger (313:14108's
 * ToggleButton) shows both: model name + effort in the caption tone.
 * Model catalogs above four entries show search, which retains focus while
 * ↑/↓ cycle the highlighted result; Enter and Tab accept it. Smaller model
 * catalogs and effort panes move focus between rows. Escape closes the popup;
 * Shift+Tab moves from its content back to the selected tab, then closes from
 * the tab strip. Provider headings paint their background only while pinned
 * by scrolling. Clearing a query restores the full list and search focus.
 * Selecting restores trigger focus without a ring until the trigger loses focus
 * or the menu reopens. Model names match a case-insensitive ordered subsequence
 * within each provider group, ranked by
 * prefix, alignment score, then catalog order. Data and submission ride the
 * same per-session ModelDirectory as the /model popup; exact-model reasoning
 * metadata and the selected effort come from the Host rather than a
 * client-owned vocabulary. A rejected selection announces through the shared
 * transient Toast anchored to the composer card; the in-menu strip with
 * Retry remains the catalog-load surface. While the directory's pending
 * selection is unsettled, the trigger shows a spinner in place of its
 * chevron, and each row whose value that selection carries shows one in place
 * of its check mark.
 */
import { MenuGroup, MenuSurface, observeStickyMenuGroups, SegmentedControl } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore,
  type CSSProperties, type KeyboardEvent, type FocusEvent,
} from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import type { ModelReasoningEffort, ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import {
  IconCheckOutlineRegular, IconChevronDownOutlineRegular, IconCloseFillRegular,
  IconDataOutlineRegular, IconWarningOutlineRegular, Input, rankByName, StateDot, Toast, useAnchoredPosition,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelSelectInjected } from './slots.ts'
import css from './ModelSelect.module.css'
import { orderModelProviders } from './provider-order.ts'

/** Which peer panel the composer model popup shows. */
type Pane = 'model' | 'effort' | 'preset'
type ExecutionPresetId = 'quick' | 'standard' | 'deep'

interface ExecutionPreset {
  id: ExecutionPresetId
  effort: string
  label: string
}

/** One dynamic effort row; undefined means preserve the provider default. */
interface EffortChoice {
  key: string
  effort: string | undefined
  label: string
}

/** Hidden portal card at a fixed origin so its viewport rectangle can be measured before paint. */
const MEASURE_STYLE: CSSProperties = { visibility: 'hidden', left: 0, top: 0 }

function menuItems(menu: HTMLElement | null): HTMLButtonElement[] {
  return Array.from(menu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"], [role="menuitemradio"]') ?? [])
}

/**
 * Render the composer model seat.
 * @param props - owner share (locked) + injected face (shared directory
 * store/verbs) + the standard locale seat.
 * @returns the trigger and, while open, the model, effort, or preset panel.
 */
export function ModelSelect(
  { locked, available, directory, load, select, t }:
  ModelSelectInjected & { locked: boolean } & PropsLocale<'model'>,
) {
  const state = useSyncExternalStore(
    fn => directory.subscribe(fn),
    () => directory.getSnapshot(),
  )
  const [open, setOpen] = useState(false)
  const [pane, setPane] = useState<Pane>('model')
  const [query, setQuery] = useState('')
  const [highlightedIndex, setHighlightedIndex] = useState<number | null>(null)
  const [selectionFocus, setSelectionFocus] = useState(false)
  const [manualOverride, setManualOverride] = useState(false)
  // The in-menu error strip serves catalog loads (its Retry re-runs the
  // load); a rejected SELECTION announces through the transient toast
  // instead, so the strip renders only while the latest failure-capable
  // action was a load.
  const lastActionRef = useRef<'load' | 'select'>('load')
  const [toast, setToast] = useState<{ seq: number; text: string } | null>(null)
  const toastSeq = useRef(0)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const groupsRef = useRef<HTMLDivElement | null>(null)
  const menuPos = useAnchoredPosition({ open, anchorRef: triggerRef, panelRef: menuRef, side: 'top', align: 'end', gap: 8, margin: 12 })
  const id = useId()

  const groups = useMemo(() => orderModelProviders(state.groups), [state.groups])
  const choices = useMemo(() => groups.flatMap(group =>
    group.models.map(model => ({
      group,
      model,
      selection: {
        provider: group.id,
        model: model.id,
        ...model.reasoning?.defaultEffort === undefined
          ? {}
          : { reasoningEffort: model.reasoning.defaultEffort },
      } satisfies ModelSelection,
    }))), [groups])
  const selectableChoiceCount = choices.reduce((count, choice) => count + (choice.group.selectable === false ? 0 : 1), 0)
  const showSearch = selectableChoiceCount > 4
  const selectableGroups = useMemo(() => groups.filter(group => group.selectable !== false), [groups])
  const filteredGroups = useMemo(() => selectableGroups.map(group => ({
    ...group, models: rankByName(group.models, showSearch ? query.trim() : ''),
  })).filter(group => group.models.length > 0), [selectableGroups, query, showSearch])
  const visibleModels = useMemo(() => filteredGroups.flatMap(group => group.models.map(model => ({
    provider: group.id, model: model.id,
  }))), [filteredGroups])
  const currentVisibleIndex = visibleModels.findIndex(model =>
    model.provider === state.current?.provider && model.model === state.current.model)
  const activeModelIndex = Math.min(highlightedIndex ?? Math.max(0, currentVisibleIndex), visibleModels.length - 1)
  const selectedIndex = state.current === null
    ? -1
    : choices.findIndex(c => c.selection.provider === state.current?.provider && c.selection.model === state.current.model)
  const currentChoice = choices[selectedIndex]
  const reasoning = currentChoice?.model.reasoning
  const effectiveEffort = state.current?.reasoningEffort ?? reasoning?.defaultEffort
  const effortLabel = reasoning === undefined
    ? state.retainedEffort
    : effectiveEffort === undefined
      ? t('effort.providerDefault')
      : reasoning.efforts.find(level => level.id === effectiveEffort)?.name ?? effectiveEffort
  const effortChoices = useMemo<readonly EffortChoice[]>(() => reasoning === undefined
    ? []
    : [
      ...reasoning.defaultEffort === undefined
        ? [{ key: 'provider-default', effort: undefined, label: t('effort.providerDefault') }]
        : [],
      ...reasoning.efforts.map((effort: ModelReasoningEffort) => ({
        key: `effort:${effort.id}`,
        effort: effort.id,
        label: effort.name,
      })),
    ], [reasoning, t])
  const executionPresets = useMemo<readonly ExecutionPreset[]>(() => {
    if (reasoning === undefined || reasoning.efforts.length < 2) return []
    const efforts = reasoning.efforts
    const quick = efforts[0]
    const deep = efforts.at(-1)
    const standard = efforts.find(effort => effort.id === reasoning.defaultEffort)
      ?? efforts[Math.floor((efforts.length - 1) / 2)]
    if (quick === undefined || deep === undefined || standard === undefined) return []
    const candidates: readonly [ExecutionPresetId, string][] = [
      ['quick', quick.id],
      ['standard', standard.id],
      ['deep', deep.id],
    ]
    const seen = new Set<string>()
    return candidates.flatMap(([presetId, effort]) => {
      if (seen.has(effort)) return []
      seen.add(effort)
      return [{ id: presetId, effort, label: t(`preset.${presetId}`) }]
    })
  }, [reasoning, t])
  const currentPreset = manualOverride
    ? undefined
    : executionPresets.find(preset => preset.effort === effectiveEffort)
  const { pending } = state
  const busy = pending !== null

  const reload = (): void => {
    lastActionRef.current = 'load'
    load()
  }

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: MouseEvent): void => {
      // The portaled card is outside the trigger subtree; check both.
      if (rootRef.current?.contains(event.target as Node) === true) return
      if (menuRef.current?.contains(event.target as Node) === true) return
      setOpen(false)
    }
    document.addEventListener('mousedown', closeOutside)
    return () => { document.removeEventListener('mousedown', closeOutside) }
  }, [open])

  useLayoutEffect(() => {
    if (!showSearch) {
      setQuery('')
      setHighlightedIndex(null)
    }
  }, [showSearch])

  const previousOpen = useRef(open)
  const previousShowSearch = useRef(showSearch)
  const pendingPanelFocus = useRef(false)
  useEffect(() => {
    const opened = open && !previousOpen.current
    const changedSearchMode = previousShowSearch.current !== showSearch
    previousOpen.current = open
    previousShowSearch.current = showSearch
    if (!open) {
      pendingPanelFocus.current = false
      return
    }
    if (opened || (changedSearchMode && pane === 'model')) pendingPanelFocus.current = true
    if (pane !== 'model') {
      pendingPanelFocus.current = false
      return
    }
    // Wait until the anchored-position hook has made the portaled panel visible;
    // focusing the search input while its measurement copy is visibility:hidden
    // is ignored by browsers even though the input is already mounted.
    if (!pendingPanelFocus.current || menuPos === null) return
    if (showSearch) {
      searchRef.current?.focus()
      pendingPanelFocus.current = false
      return
    }
    // Open on the checked value, falling back to the first enabled option.
    const checked = menuRef.current?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]:not([disabled])')
    const target = checked ?? menuItems(menuRef.current).find(item => !item.disabled)
    // Rows disabled by a pending selection cannot retain focus; the trigger
    // keeps the menu's keyboard handlers reachable until the request settles.
    ;(target ?? triggerRef.current)?.focus()
    pendingPanelFocus.current = false
  }, [open, pane, showSearch, menuPos])

  useEffect(() => {
    const viewport = groupsRef.current
    if (viewport === null) return
    return observeStickyMenuGroups(viewport)
  }, [available, open, pane, filteredGroups])

  useLayoutEffect(() => {
    if (open && pane === 'model' && activeModelIndex >= 0) {
      menuItems(menuRef.current)[activeModelIndex]?.scrollIntoView({ block: 'nearest' })
    }
  }, [open, pane, activeModelIndex, visibleModels])

  if (!available) return null

  const show = (): void => {
    setSelectionFocus(false)
    triggerRef.current?.focus()
    setQuery('')
    setHighlightedIndex(null)
    setPane('model')
    setOpen(true)
    reload()
  }

  const changeQuery = (next: string): void => {
    setQuery(next)
    setHighlightedIndex(0)
  }

  const close = (restoreFocus = false): void => {
    setOpen(false)
    setPane('model')
    if (restoreFocus) queueMicrotask(() => { triggerRef.current?.focus() })
  }

  const closeAfterSelection = (): void => {
    setSelectionFocus(true)
    close(true)
  }

  const moveFocus = (offset: number): void => {
    const items = menuItems(menuRef.current)
    if (items.length === 0) return
    const active = items.findIndex(item => item === document.activeElement)
    // Focus outside the rows (the trigger, which keeps it while the menu
    // opens) enters at the end the step comes from: the first row forward,
    // the last row backward.
    const next = active === -1
      ? (offset > 0 ? 0 : items.length - 1)
      : (active + offset + items.length) % items.length
    items[next]?.focus()
  }

  const onRootKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.nativeEvent.isComposing || event.defaultPrevented) return
    if (event.key === 'Escape' && open) {
      event.preventDefault()
      close(true)
      return
    }
    if (!open) return
    if (pane === 'model' && showSearch && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault()
      if (!busy && visibleModels.length > 0) {
        const direction = event.key === 'ArrowDown' ? 1 : -1
        setHighlightedIndex((activeModelIndex + direction + visibleModels.length) % visibleModels.length)
        searchRef.current?.focus()
      }
      return
    }
    if (pane === 'model' && showSearch && event.target instanceof HTMLInputElement
      && (event.key === 'Enter' || (event.key === 'Tab' && !event.shiftKey))) {
      if (event.key === 'Tab' && visibleModels.length === 0) return
      event.preventDefault()
      const highlighted = visibleModels[activeModelIndex]
      if (!busy && highlighted !== undefined) choose(highlighted)
      return
    }
    // Tab settles like Enter and Shift+Tab leaves like Escape, so the menu's
    // keys mean what they mean in the composer. Both are consumed: the card
    // keeps the browser's focus traversal out while it is open.
    if (event.key === 'Tab') {
      if (event.shiftKey) {
        // Let native traversal move through the panel and back to its selected
        // tab. Leaving from the tab strip returns to the trigger.
        if (event.target instanceof Element && event.target.getAttribute('role') !== 'tab') return
        event.preventDefault()
        close(true)
        return
      }
      // Settling activates the row the keyboard is on; with focus still on the
      // trigger, Tab enters the menu at the value in use instead. Any other
      // control inside the card (a retry button) keeps the browser's traversal,
      // so the keystroke stays unconsumed there.
      const focused = document.activeElement
      const rows = menuItems(menuRef.current)
      if (focused instanceof HTMLButtonElement && rows.includes(focused)) {
        event.preventDefault()
        focused.click()
        return
      }
      if (focused !== triggerRef.current) return
      event.preventDefault()
      if (pane === 'model' && showSearch) {
        setHighlightedIndex(null)
        searchRef.current?.focus()
        return
      }
      const checked = menuRef.current?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]:not([disabled])')
      ;(checked ?? rows.find(item => !item.disabled))?.focus()
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      moveFocus(event.key === 'ArrowDown' ? 1 : -1)
    }
  }

  const onBlur = (event: FocusEvent<HTMLDivElement>): void => {
    if (event.relatedTarget instanceof Node && (
      rootRef.current?.contains(event.relatedTarget) === true
      || menuRef.current?.contains(event.relatedTarget) === true
    )) return
    close()
  }

  const settleSelection = (result: Awaited<ReturnType<ModelSelectInjected['select']>>): void => {
    if (result === undefined) return
    if (result.ok) {
      if (rootRef.current !== null) closeAfterSelection()
      return
    }
    const { error } = result
    toastSeq.current += 1
    setToast({
      seq: toastSeq.current,
      text: error.code === 'session/writer-held'
        ? t('error.sessionInUse')
        : t('error.action', { message: `${error.code}: ${error.message}` }),
    })
  }

  const submit = (selection: ModelSelection, onSuccess?: () => void): void => {
    lastActionRef.current = 'select'
    // Disabled option rows cannot retain focus while a selection is pending.
    setSelectionFocus(true)
    triggerRef.current?.focus()
    void select(selection).then((result) => {
      if (result?.ok) onSuccess?.()
      settleSelection(result)
    })
  }

  const choose = (selection: ModelSelection): void => {
    if (state.current?.provider === selection.provider && state.current.model === selection.model) {
      closeAfterSelection()
      return
    }
    submit(selection, () => { setManualOverride(true) })
  }

  const chooseEffort = (effort: string | undefined): void => {
    if (state.current === null) return
    if (effectiveEffort === effort) {
      closeAfterSelection()
      return
    }
    const selection: ModelSelection = {
      provider: state.current.provider,
      model: state.current.model,
      ...effort === undefined ? {} : { reasoningEffort: effort },
    }
    submit(selection, () => { setManualOverride(true) })
  }

  const choosePreset = (preset: ExecutionPreset): void => {
    if (state.current === null) return
    if (effectiveEffort === preset.effort) {
      setManualOverride(false)
      closeAfterSelection()
      return
    }
    submit({
      provider: state.current.provider,
      model: state.current.model,
      reasoningEffort: preset.effort,
    }, () => { setManualOverride(false) })
  }

  const waiting = state.current === null && state.status === 'loading'
  const modelLabel = waiting
    ? t('trigger.loading')
    : currentChoice?.model.name
      ?? (state.current === null ? t('trigger.fallback') : `${state.current.provider}/${state.current.model}`)
  const triggerLabel = effortLabel === undefined ? modelLabel : `${modelLabel} · ${effortLabel}`
  const triggerAria = waiting
    ? t('trigger.loading')
    : state.current === null
      ? t('trigger.selectAria')
      : effortLabel === undefined
        ? t('trigger.aria', { model: modelLabel })
        : t('trigger.ariaEffort', { model: modelLabel, effort: effortLabel })
  const tabs: { value: Pane; label: string }[] = [{ value: 'model', label: t('menu.model') }]
  if (reasoning !== undefined) tabs.push({ value: 'effort', label: t('menu.effort') })
  if (executionPresets.length > 1) tabs.push({ value: 'preset', label: t('menu.preset') })

  let modelIndex = 0
  return (
    <div
      ref={rootRef}
      className={css.root}
      onKeyDown={onRootKeyDown}
      onBlur={onBlur}
      onMouseDown={(event) => {
        // WebKit blurs a focused row before click unless the button's mousedown keeps focus.
        if (event.target instanceof Element && event.target.closest('[role="tab"]') !== null) return
        if (event.target instanceof Element && event.target.closest('button') !== null) event.preventDefault()
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className={css.trigger}
        aria-label={triggerAria}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? `${id}-menu` : undefined}
        title={triggerLabel}
        aria-busy={busy}
        data-selection-focus={selectionFocus ? '' : undefined}
        onBlur={() => { setSelectionFocus(false) }}
        disabled={locked}
        onClick={() => {
          if (open) {
            close(true)
          } else {
            show()
          }
        }}
      >
        <IconDataOutlineRegular className={css.triggerIcon} size={16} />
        <span className={css.triggerLabel}>{modelLabel}</span>
        {effortLabel !== undefined && <span className={css.triggerEffort}>{effortLabel}</span>}
        {busy
          ? <StateDot state="ongoing" />
          : <IconChevronDownOutlineRegular className={clsx(css.chevron, open && css.chevronOpen)} />}
      </button>

      {/* Portaled to body (Menu primitive's portal mode) so the sidebar and
          column overflow clips cannot crop the card; synthetic events still
          bubble through this React subtree, keeping onKeyDown/onBlur live. */}
      {open && createPortal(
        <MenuSurface
          ref={menuRef}
          id={`${id}-menu`}
          className={css.menu}
          style={menuPos ?? MEASURE_STYLE}
          role="group"
          aria-label={t('menu.aria')}
          aria-busy={state.status === 'loading' || busy}
        >
          {tabs.length > 1 && (
            <SegmentedControl
              id={`${id}-tabs`}
              className={css.tabs}
              label={t('menu.aria')}
              value={pane}
              options={tabs}
              onChange={setPane}
            />
          )}

          <div
            id={`${id}-tabs-${pane}-panel`}
            className={css.panel}
            role="tabpanel"
            aria-labelledby={tabs.length > 1 ? `${id}-tabs-${pane}` : undefined}
            aria-label={tabs.length === 1 ? tabs[0]?.label : undefined}
          >
            {pane === 'model' && (
              <>
                {showSearch && <div className={css.searchRow}>
                  <Input
                    ref={searchRef}
                    className={clsx(css.search, query !== '' && css.searchWithQuery)}
                    type="text"
                    role="searchbox"
                    aria-label={t('search.placeholder')}
                    aria-controls={`${id}-models`}
                    aria-activedescendant={activeModelIndex < 0 ? undefined : `${id}-model-${activeModelIndex}`}
                    placeholder={t('search.placeholder')}
                    value={query}
                    readOnly={busy}
                    onChange={(event) => { changeQuery(event.target.value) }}
                  />
                  {query !== '' && (
                    <button
                      type="button"
                      className={css.searchClear}
                      aria-label={t('search.clear')}
                      disabled={busy}
                      onClick={() => {
                        changeQuery('')
                        searchRef.current?.focus()
                      }}
                    >
                      <IconCloseFillRegular />
                    </button>
                  )}
                </div>}
                {state.status === 'loading' && (
                  <div className={css.status}>{t('status.loading')}</div>
                )}
                {state.error !== null && lastActionRef.current === 'load' && (
                  <div className={css.error}>
                    <span>{t('error.action', { message: state.error })}</span>
                    <button type="button" className={css.retry} onClick={reload}>{t('retry')}</button>
                  </div>
                )}
                {state.failures.map(failure => (
                  <div className={css.warning} key={failure.id}>
                    <span>{t('warning.groupLoad', { name: failure.id === 'deepseek-account' ? t('provider.account') : failure.name, message: failure.message })}</span>
                    <button type="button" className={css.retry} onClick={reload}>{t('retry')}</button>
                  </div>
                ))}
                <div
                  ref={groupsRef}
                  id={`${id}-models`}
                  className={clsx(css.groups, 'scrollable')}
                  role="menu"
                  aria-label={t('menu.model')}
                  hidden={filteredGroups.length === 0}
                >
                  {filteredGroups.map((group) => {
                    return (
                      <MenuGroup key={group.id} label={group.id === 'deepseek-account' ? t('provider.account') : group.name}>
                        {group.models.map((model) => {
                          const index = modelIndex++
                          const selected = state.current?.provider === group.id && state.current.model === model.id
                          return (
                            <button
                              type="button"
                              role="menuitemradio"
                              aria-checked={selected}
                              id={`${id}-model-${index}`}
                              tabIndex={showSearch ? -1 : 0}
                              onFocus={() => { setHighlightedIndex(index) }}
                              data-highlighted={index === activeModelIndex ? '' : undefined}
                              className={clsx(
                                css.option, css.modelOption, selected && css.selected, index === activeModelIndex && css.optionActive,
                              )}
                              onMouseMove={busy || index === activeModelIndex ? undefined : () => {
                                if (showSearch) setHighlightedIndex(index)
                                else menuItems(menuRef.current)[index]?.focus()
                              }}
                              key={model.id}
                              title={model.name}
                              disabled={busy}
                              onClick={() => { choose({ provider: group.id, model: model.id }) }}
                            >
                              <span className={css.optionCopy}>
                                <span className={css.modelName}>{model.name}</span>
                              </span>
                              <span className={css.check}>
                                {pending?.provider === group.id && pending.model === model.id
                                  ? <StateDot state="ongoing" />
                                  : selected ? <IconCheckOutlineRegular /> : null}
                              </span>
                            </button>
                          )
                        })}
                      </MenuGroup>
                    )
                  })}
                </div>
                {state.status === 'ready' && filteredGroups.length === 0 && (
                  <div className={css.empty} role="status">{t(selectableChoiceCount === 0 ? 'empty.models' : 'search.empty')}</div>
                )}
              </>
            )}

            {pane === 'effort' && (
              <>
                {state.error !== null && lastActionRef.current === 'load' && (
                  <div className={css.error}>
                    <span>{t('error.action', { message: state.error })}</span>
                    <button type="button" className={css.retry} onClick={reload}>{t('action.reload')}</button>
                  </div>
                )}
                <div role="menu" aria-label={t('menu.effort')}>
                  {effortChoices.length === 0
                    ? <div className={css.empty}>{t('empty.efforts')}</div>
                    : effortChoices.map(level => (
                      <button
                        type="button"
                        role="menuitemradio"
                        aria-checked={effectiveEffort === level.effort}
                        className={clsx(css.option, effectiveEffort === level.effort && css.selected)}
                        key={level.key}
                        disabled={busy}
                        onClick={() => { chooseEffort(level.effort) }}
                      >
                        <span className={css.optionCopy}>
                          <span className={css.modelName}>{level.label}</span>
                        </span>
                        <span className={css.check}>
                          {pending !== null && pending.provider === state.current?.provider
                            && pending.model === state.current.model && pending.reasoningEffort === level.effort
                            ? <StateDot state="ongoing" />
                            : effectiveEffort === level.effort ? <IconCheckOutlineRegular /> : null}
                        </span>
                      </button>
                    ))}
                </div>
              </>
            )}

            {pane === 'preset' && (
              <>
                <div role="menu" aria-label={t('menu.preset')}>
                  <div className={css.status}>{t('preset.currentModelOnly')}</div>
                  {executionPresets.map(preset => (
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={currentPreset?.id === preset.id}
                      className={clsx(css.option, currentPreset?.id === preset.id && css.selected)}
                      key={preset.id}
                      disabled={busy}
                      onClick={() => { choosePreset(preset) }}
                    >
                      <span className={css.optionCopy}>
                        <span className={css.modelName}>{preset.label}</span>
                      </span>
                      <span className={css.check}>
                        {pending !== null && pending.provider === state.current?.provider
                          && pending.model === state.current.model && pending.reasoningEffort === preset.effort
                          ? <StateDot state="ongoing" />
                          : currentPreset?.id === preset.id ? <IconCheckOutlineRegular /> : null}
                      </span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </MenuSurface>,
        document.body,
      )}
      {toast !== null && (
        <Toast
          key={toast.seq}
          text={toast.text}
          icon={<IconWarningOutlineRegular />}
          anchor={rootRef.current?.closest<HTMLElement>('[data-composer-card]') ?? null}
          onDone={() => { setToast(null) }}
        />
      )}
    </div>
  )
}
