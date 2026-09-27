/**
 * Web composer half: a chip beside the model, permission, and compaction chips
 * showing whether this Session retries a quota-exhausted request once an hour,
 * with a menu that turns it on or off.
 *
 * The current setting is read from the `quotaRetry` Session projection (the
 * host pushes it on every Session event, so a change made in another tab or by
 * a typed line lands here) and written by submitting `/quota-retry <argument>`,
 * so the composer and a typed line share exactly one write path.
 *
 * Loaded as a dynamic client module; the factory id must equal the package name
 * so the bundle route and the module-table identity agree.
 */

/** Option id that turns long-term retry on for this Session. */
const ON_OPTION = 'on'

/** Option id that turns it off for this Session. */
const OFF_OPTION = 'off'

/** Option id that clears the Session's own value and follows the deployment default. */
const DEFAULT_OPTION = 'default'

/** Option id of the non-selectable failure row. */
const ERROR_OPTION = 'error'

/** Dictionary namespace owned by this plugin. */
const NS = 'llmQuotaRetry'

/** Chinese copy. */
const zh = {
  'chip.on': '额度重试 开',
  'chip.off': '额度重试 关',
  'menu.heading': '原生快速重试用尽后，每小时重试一次额度不足的请求，不限次数',
  'option.on': '开启',
  'option.off': '关闭',
  'option.default': '默认（{state}）',
  'option.defaultUnknown': '默认',
  'state.on': '开',
  'state.off': '关',
  'note.inherited': '继承自父会话',
  'mode': '额度不足长期重试：{state}',
  'error.command': '设置失败：{message}',
  'error.unavailable': '宿主没有提供 /quota-retry 命令',
}

/** English copy. */
const en = {
  'chip.on': 'Quota retry on',
  'chip.off': 'Quota retry off',
  'menu.heading': 'After the provider\'s fast retries give up on quota, retry once an hour without a limit',
  'option.on': 'On',
  'option.off': 'Off',
  'option.default': 'Default ({state})',
  'option.defaultUnknown': 'Default',
  'state.on': 'on',
  'state.off': 'off',
  'note.inherited': 'inherited from the parent session',
  'mode': 'Long-term retry through an exhausted quota: {state}',
  'error.command': 'The setting was not changed: {message}',
  'error.unavailable': 'This host offers no /quota-retry command',
}

window.__ModuleLoader__.load({
  id: 'dsh-llm-quota-retry',
  factory(require) {
    const React = require('react')
    // `ui-primitives` is a baseline platform module: the shell seeds it into the
    // frozen module table, so a dynamic bundle requires it without declaring an
    // external. Its Menu keeps this chip's popup identical to its siblings.
    const { IconChevronDownOutlineRegular, Menu } = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement
    const { useState } = React

    /** The chip's inline chrome, matching the sibling composer chips. */
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
        anchor: h('button', {
          type: 'button',
          style: {
            ...triggerStyle,
            ...hover && !busy ? { background: 'var(--dsw-alias-interactive-bg-hover)' } : {},
            ...busy ? { color: 'var(--dsw-alias-label-dimmed)', cursor: 'default' } : {},
          },
          title,
          'aria-label': t('mode', { state: stateText }),
          'aria-haspopup': 'menu',
          'aria-expanded': open,
          disabled: busy,
          onClick: () => { setOpen(!open) },
          onMouseEnter: () => { setHover(true) },
          onMouseLeave: () => { setHover(false) },
        },
        h('span', { style: labelStyle }, label),
        h('span', { style: { ...chevronStyle, ...open ? { transform: 'rotate(180deg)' } : {} }, 'aria-hidden': true },
          h(IconChevronDownOutlineRegular)),
        ),
      })
    }

    return {
      inject: ['slots', 'sessions', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'llm-quota-retry: dictionaries')
        const t = ctx.locale.bind(NS)
        const sessions = ctx.sessions
        const submit = async (sessionId, argument) => {
          const live = sessions.binding(sessionId)?.session
          if (live === undefined) throw new Error('this session is not materialized yet')
          const result = await live.command(`/quota-retry ${argument}`)
          if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
          if (!result.value.matched) throw new Error(t('error.unavailable'))
          return true
        }
        ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
          name: 'conversation.input.left',
          id: 'llm-quota-retry',
          order: 31,
          locale: NS,
          inject: sessionId => ({ setEnabled: argument => submit(sessionId, argument) }),
        }, QuotaRetryChip))
      },
    }
  },
})
