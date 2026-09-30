/**
 * Web composer half: two chips beside the model, permission, and compaction
 * chips. The first shows whether this Session retries a quota-exhausted request
 * once an hour, with a menu that turns it on or off; the second selects the
 * route pool governing the Session, so the pool is chosen where the Session is
 * read instead of in configuration.
 *
 * Both settings are read from the `quotaRetry` Session projection (the host
 * pushes it on every Session event, so a change made in another tab or by a
 * typed line lands here) and written by submitting `/quota-retry <argument>`
 * and `/quota-pool <argument>`, so the composer and a typed line share exactly
 * one write path per setting.
 *
 * Loaded as a dynamic client module; the factory id must equal the package name
 * so the bundle route and the module-table identity agree.
 */

// A combo batch concatenates every plugin bundle into one classic script, so a
// top-level declaration here shares one lexical scope with every other
// bundle's. A name two bundles both declare is a SyntaxError that takes the
// whole batch down, so this bundle declares nothing at the top level: the IIFE
// owns every name, and only the `load` call inside it reaches the shell.
;(function () {
/** Option id that turns long-term retry on for this Session. */
const ON_OPTION = 'on'

/** Option id that switches the setting off for this Session. */
const OFF_OPTION = 'off'

/** Option id that clears the Session's own value and returns to the default. */
const DEFAULT_OPTION = 'default'

/** Option id of the non-selectable failure row. */
const ERROR_OPTION = 'error'

/** Dictionary namespace owned by this plugin. */
const NS = 'llmQuotaRetry'

/** Chinese copy. */
const zh = {
  'chip.on': '额度重试 开',
  'chip.off': '额度重试 关',
  'menu.heading': '额度不足时自动切到本会话 route pool 里有余额的一条并立刻重试；都没有余额才每小时重试一次，不限次数',
  'option.on': '开启',
  'option.off': '关闭',
  'option.default': '默认（{state}）',
  'option.defaultUnknown': '默认',
  'state.on': '开',
  'state.off': '关',
  'note.inherited': '继承自父会话',
  'mode': '额度不足的处理方式：{state}',
  'pool.chip.pool': '池 · {pool}',
  'pool.chip.default': '池 · 默认',
  'pool.chip.off': '池 · 关',
  'pool.menu.heading': '这个会话的 route 池：某条 route 额度不足时换到池里还有余额的一条',
  'pool.option.default': '默认（按当前模型自动判断在哪个池）',
  'pool.option.off': '关闭（额度不足只等待，不换 provider）',
  'pool.mode': 'route 池：{pool}',
  'error.command': '设置失败：{message}',
  'error.unavailable': '宿主没有提供 /{command} 命令',
}

/** English copy. */
const en = {
  'chip.on': 'Quota retry on',
  'chip.off': 'Quota retry off',
  'menu.heading': 'On an exhausted quota, move this session to a route of its pool that has balance and retry at once; wait an hour between attempts only when none has',
  'option.on': 'On',
  'option.off': 'Off',
  'option.default': 'Default ({state})',
  'option.defaultUnknown': 'Default',
  'state.on': 'on',
  'state.off': 'off',
  'note.inherited': 'inherited from the parent session',
  'mode': 'Handling an exhausted quota: {state}',
  'pool.chip.pool': 'Pool · {pool}',
  'pool.chip.default': 'Pool · default',
  'pool.chip.off': 'Pool · off',
  'pool.menu.heading': 'The route pool for this session: when one route is out of allowance, move to a route of the pool that still has some',
  'pool.option.default': 'Default (inferred from the model the session is on)',
  'pool.option.off': 'Off (wait out an exhausted allowance without changing provider)',
  'pool.mode': 'Route pool: {pool}',
  'error.command': 'The setting was not changed: {message}',
  'error.unavailable': 'This host offers no /{command} command',
}

window.__ModuleLoader__.load({
  id: 'dsh-llm-quota-retry',
  factory(require) {
    const React = require('react')
    // `ui-primitives` is a baseline platform module: the shell seeds it into the
    // frozen module table, so a dynamic bundle requires it without declaring an
    // external. Its Menu keeps these chips' popups identical to their siblings.
    const { IconChevronDownOutlineRegular, Menu } = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement
    const { useState } = React

    /** The chips' inline chrome, matching the sibling composer chips. */
    const triggerStyle = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '4px',
      minWidth: 0,
      maxWidth: '220px',
      height: '28px',
      padding: '0 4px 0 8px',
      border: 'none',
      borderRadius: '24px',
      outline: 'none',
      background: 'transparent',
      color: 'var(--dsw-alias-label-secondary)',
      fontSize: '13px',
      lineHeight: '20px',
      fontWeight: 500,
      cursor: 'pointer',
    }

    const chevronStyle = {
      display: 'inline-flex',
      flex: '0 0 auto',
      color: 'var(--dsw-alias-label-caption)',
      transition: 'transform 120ms ease',
    }

    const labelStyle = {
      minWidth: 0,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    }

    const detailStyle = {
      color: 'var(--dsw-alias-label-tertiary)',
      fontSize: '11px',
      lineHeight: '14px',
    }

    /**
     * One menu option, with an optional secondary line.
     * @param props - option text and optional detail line.
     */
    function Row({ label, detail }) {
      if (detail === undefined) return h('span', { style: labelStyle }, label)
      return h('span', { style: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 } },
        h('span', { style: labelStyle }, label),
        h('span', { style: detailStyle }, detail))
    }

    /**
     * The composer chip trigger both chips wear: its label, its chevron, and the
     * hover and busy chrome the sibling composer chips use.
     * @param props - open and busy state, the pointer and click handlers, the tooltip, and the label.
     * @returns the anchor element a menu positions against.
     */
    function TriggerButton({ open, busy, hover, title, label, ariaLabel, onToggle, onEnter, onLeave }) {
      return h('button', {
        type: 'button',
        style: {
          ...triggerStyle,
          ...hover && !busy ? { background: 'var(--dsw-alias-interactive-bg-hover)' } : {},
          ...busy ? { color: 'var(--dsw-alias-label-dimmed)', cursor: 'default' } : {},
        },
        title,
        'aria-label': ariaLabel,
        'aria-haspopup': 'menu',
        'aria-expanded': open,
        disabled: busy,
        onClick: onToggle,
        onMouseEnter: onEnter,
        onMouseLeave: onLeave,
      },
      h('span', { style: labelStyle }, label),
      h('span', { style: { ...chevronStyle, ...open ? { transform: 'rotate(180deg)' } : {} }, 'aria-hidden': true },
        h(IconChevronDownOutlineRegular)))
    }

    /**
     * The composer chip: this Session's long-term quota retry switch.
     * @param props - Session standard seats plus this slot's injected writer.
     */
    function QuotaRetryChip({ useProjection, setEnabled, t }) {
      const facts = useProjection('quotaRetry')
      const [open, setOpen] = useState(false)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [hover, setHover] = useState(false)

      // A composition without the host row publishes no projection: the chip is
      // absent rather than offering a switch nothing would honor.
      if (facts === undefined) return null

      const enabled = facts.enabled === true
      const stateText = t(enabled ? 'state.on' : 'state.off')
      const label = t(enabled ? 'chip.on' : 'chip.off')
      const currentId = facts.source === 'default' ? DEFAULT_OPTION : enabled ? ON_OPTION : OFF_OPTION
      const inheritedNote = facts.source === 'inherited' ? t('note.inherited') : null
      const defaultState = facts.defaultEnabled === true ? t('state.on') : t('state.off')
      const title = inheritedNote === null ? t('menu.heading') : `${t('menu.heading')} · ${inheritedNote}`

      const items = [{ type: 'label', id: 'heading', text: t('menu.heading') }]
      if (inheritedNote !== null) items.push({ type: 'label', id: 'inherited', text: inheritedNote })
      if (error !== null) items.push({ id: ERROR_OPTION, label: error, disabled: true, danger: true })
      items.push({ id: ON_OPTION, label: h(Row, { label: t('option.on') }) })
      items.push({ id: OFF_OPTION, label: h(Row, { label: t('option.off') }) })
      items.push({
        id: DEFAULT_OPTION,
        label: h(Row, { label: t('option.default', { state: defaultState }) }),
      })

      const choose = (id) => {
        if (id === ERROR_OPTION) return
        setOpen(false)
        if (id === currentId) return
        setBusy(true)
        setError(null)
        Promise.resolve(setEnabled(id))
          .catch((failure) => {
            setError(t('error.command', {
              message: failure instanceof Error ? failure.message : String(failure),
            }))
            setOpen(true)
          })
          .finally(() => { setBusy(false) })
      }

      return h(Menu, {
        open,
        items,
        selectedId: currentId,
        onSelect: choose,
        onClose: () => { setOpen(false) },
        side: 'top',
        portal: true,
        anchor: h(TriggerButton, {
          open,
          busy,
          hover,
          title,
          label,
          ariaLabel: t('mode', { state: stateText }),
          onToggle: () => { setOpen(!open) },
          onEnter: () => { setHover(true) },
          onLeave: () => { setHover(false) },
        }),
      })
    }

    /**
     * The composer chip selecting the route pool governing this Session: which
     * route the plugin moves to when the route in use runs out of allowance.
     * @param props - Session standard seats plus this slot's injected writer.
     */
    function QuotaPoolChip({ useProjection, setPool, t }) {
      const facts = useProjection('quotaRetry')
      const [open, setOpen] = useState(false)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [hover, setHover] = useState(false)

      // The absence rule is the retry chip's: a composition without the host row
      // publishes no projection, so there is no pool to show or to select.
      if (facts === undefined) return null

      const poolNames = Array.isArray(facts.pools) ? facts.pools : []
      const poolName = typeof facts.pool === 'string' && facts.pool !== '' ? facts.pool : null
      const switchedOff = facts.poolSource === 'off'
      const label = poolName === null
        ? t(switchedOff ? 'pool.chip.off' : 'pool.chip.default')
        : t('pool.chip.pool', { pool: poolName })
      const currentId = switchedOff ? OFF_OPTION : poolName === null ? DEFAULT_OPTION : poolName
      const inheritedNote = facts.poolSource === 'inherited' ? t('note.inherited') : null
      // The bare word for the setting in force: the pool's own name, or the
      // retry chip's words for an inferred default and for a session opted out.
      const stateWord = poolName === null ? t(switchedOff ? 'state.off' : 'option.defaultUnknown') : poolName
      const title = inheritedNote === null ? t('pool.menu.heading') : `${t('pool.menu.heading')} · ${inheritedNote}`

      const items = [{ type: 'label', id: 'pool-heading', text: t('pool.menu.heading') }]
      if (inheritedNote !== null) items.push({ type: 'label', id: 'pool-inherited', text: inheritedNote })
      if (error !== null) items.push({ id: ERROR_OPTION, label: error, disabled: true, danger: true })
      for (const name of poolNames) items.push({ id: name, label: h(Row, { label: name }) })
      items.push({ id: DEFAULT_OPTION, label: h(Row, { label: t('pool.option.default') }) })
      items.push({ id: OFF_OPTION, label: h(Row, { label: t('pool.option.off') }) })

      const choose = (id) => {
        if (id === ERROR_OPTION) return
        setOpen(false)
        if (id === currentId) return
        setBusy(true)
        setError(null)
        Promise.resolve(setPool(id))
          .catch((failure) => {
            setError(t('error.command', {
              message: failure instanceof Error ? failure.message : String(failure),
            }))
            setOpen(true)
          })
          .finally(() => { setBusy(false) })
      }

      return h(Menu, {
        open,
        items,
        selectedId: currentId,
        onSelect: choose,
        onClose: () => { setOpen(false) },
        side: 'top',
        portal: true,
        anchor: h(TriggerButton, {
          open,
          busy,
          hover,
          title,
          label,
          ariaLabel: t('pool.mode', { pool: stateWord }),
          onToggle: () => { setOpen(!open) },
          onEnter: () => { setHover(true) },
          onLeave: () => { setHover(false) },
        }),
      })
    }

    return {
      inject: ['slots', 'sessions', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'llm-quota-retry: dictionaries')
        const t = ctx.locale.bind(NS)
        const sessions = ctx.sessions

        /**
         * Submit one `/<command> <argument>` line for a Session: the one write
         * path a chip and a typed line share.
         * @param sessionId - the Session the chip is rendered for.
         * @param command - command name, without its leading slash.
         * @param argument - the argument word the command parses.
         * @returns true once the host ran the command.
         */
        const submit = async (sessionId, command, argument) => {
          const live = sessions.binding(sessionId)?.session
          if (live === undefined) throw new Error('this session is not materialized yet')
          const result = await live.command(`/${command} ${argument}`)
          if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
          if (!result.value.matched) throw new Error(t('error.unavailable', { command }))
          return true
        }
        ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
          name: 'conversation.input.left',
          id: 'llm-quota-retry',
          order: 31,
          locale: NS,
          inject: sessionId => ({ setEnabled: argument => submit(sessionId, 'quota-retry', argument) }),
        }, QuotaRetryChip))
        ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
          name: 'conversation.input.left',
          id: 'llm-quota-retry-pool',
          order: 32,
          locale: NS,
          inject: sessionId => ({ setPool: argument => submit(sessionId, 'quota-pool', argument) }),
        }, QuotaPoolChip))
      },
    }
  },
})
})()
