#!/usr/bin/env node
/**
 * Offline probe for the Web composer half: loads `client.js` through a stub
 * module loader, runs its factory and `apply` against a fake Client context,
 * and renders the chip as a plain function to check what it offers.
 *
 * Run with `node probe/client-probe.mjs` from the package directory. Exits
 * non-zero on the first failed check.
 */

import assert from 'node:assert/strict'

/** One registered dynamic module, captured by the stub loader. */
let module_ = null

globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      module_ = definition
    },
  },
}

await import('../client.js')

assert.ok(module_ !== null, 'client.js must register a dynamic module')
assert.equal(module_.id, 'dsh-llm-quota-retry', 'the factory id must equal the package name')

/** Stub React: elements are plain objects, so rendering needs no DOM. */
const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
}

const Menu = function Menu() {}
const IconChevronDownOutlineRegular = function IconChevronDownOutlineRegular() {}

/** The module table the factory may require. */
const MODULES = {
  react: React,
  '@deepseek-ai/dsh-client-ui-primitives': { Menu, IconChevronDownOutlineRegular },
}

const factoryResult = module_.factory(specifier => {
  const found = MODULES[specifier]
  assert.ok(found !== undefined, `the client factory required an undeclared module: ${specifier}`)
  return found
})

/** Minimal Client context surface the client half uses. */
function createClientContext({ session } = {}) {
  const dictionaries = []
  const injections = []
  const registrations = []
  const commands = []
  const cleanups = []
  const context = {
    effect(callback) {
      const cleanup = callback()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
    },
    locale: {
      register(ns, dicts) {
        dictionaries.push({ ns, dicts })
        return () => {}
      },
      bind: ns => (key, params) => {
        const entry = dictionaries.find(candidate => candidate.ns === ns)
        const text = entry?.dicts.en[key] ?? key
        return params === undefined
          ? text
          : text.replace(/\{(\w+)\}/gu, (_, name) => String(params[name]))
      },
    },
    sessions: {
      binding: () => (session === undefined ? undefined : { session }),
    },
    slots: {
      inject(key, callback) {
        injections.push(key)
        callback()
        return () => {}
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    },
    dictionaries,
    injections,
    registrations,
    commands,
    cleanups,
  }
  return context
}

/** A live-session stub recording the command lines the chip submits. */
function createLiveSession(commands, outcome = { ok: true, value: { matched: true } }) {
  return {
    command: async (line) => {
      commands.push(line)
      return outcome
    },
  }
}

const checks = []
function check(name, run) {
  checks.push({ name, run })
}

/** Render the chip as a plain function with the seats this slot provides. */
function render(component, facts, submit) {
  return component({
    useProjection: key => (key === 'quotaRetry' ? facts : undefined),
    setEnabled: submit,
    t: (key, params) => key + (params === undefined ? '' : `(${Object.values(params).join(',')})`),
  })
}

/** The menu item ids a rendered chip offers. */
function optionIds(element) {
  return element.props.items.filter(item => typeof item.id === 'string').map(item => item.id)
}

check('apply registers its dictionary, slot contribution, and the composer slot', async () => {
  const context = createClientContext()
  factoryResult.apply(context)
  assert.deepEqual(context.injections, ['conversation.input.left'])
  assert.equal(context.dictionaries.length, 1)
  assert.equal(context.dictionaries[0].ns, 'llmQuotaRetry')
  // Bilingual balance: the chip must ship both shipped locales.
  for (const locale of ['zh', 'en']) {
    assert.ok(context.dictionaries[0].dicts[locale] !== undefined, `missing the ${locale} dictionary`)
  }
  assert.equal(context.registrations.length, 1)
  const { options, component } = context.registrations[0]
  assert.deepEqual({ name: options.name, id: options.id, order: options.order, locale: options.locale }, {
    name: 'conversation.input.left',
    id: 'llm-quota-retry',
    order: 31,
    locale: 'llmQuotaRetry',
  })
  assert.equal(typeof component, 'function')
})

check('the chip is absent when the host publishes no projection', async () => {
  const context = createClientContext()
  factoryResult.apply(context)
  const { component } = context.registrations[0]
  assert.equal(render(component, undefined, async () => true), null)
})

check('the chip offers on, off, and default, and marks the session default', async () => {
  const context = createClientContext()
  factoryResult.apply(context)
  const { component } = context.registrations[0]
  const element = render(component, { enabled: false, defaultEnabled: false, source: 'default' }, async () => true)
  assert.equal(element.type, Menu)
  assert.deepEqual(optionIds(element), ['heading', 'on', 'off', 'default'])
  assert.equal(element.props.selectedId, 'default')
  assert.equal(element.props.anchor.props['aria-label'], 'mode(state.off)')
})

check('an inherited setting is named as inherited and selects the value in force', async () => {
  const context = createClientContext()
  factoryResult.apply(context)
  const { component } = context.registrations[0]
  const element = render(component, { enabled: true, defaultEnabled: false, source: 'inherited' }, async () => true)
  assert.ok(optionIds(element).includes('inherited'))
  assert.equal(element.props.selectedId, 'on')
  assert.equal(element.props.anchor.props['aria-label'], 'mode(state.on)')
})

check('the deployment default is shown on the default option, not assumed off', async () => {
  const context = createClientContext()
  factoryResult.apply(context)
  const { component } = context.registrations[0]
  const element = render(component, { enabled: true, defaultEnabled: true, source: 'default' }, async () => true)
  const fallback = element.props.items.find(item => item.id === 'default')
  assert.equal(fallback.label.props.label, 'option.default(state.on)')
})

check('choosing an option submits the shared /quota-retry write path', async () => {
  const commands = []
  const context = createClientContext({ session: createLiveSession(commands) })
  factoryResult.apply(context)
  const { setEnabled } = context.registrations[0].options.inject('probe-session')
  assert.equal(typeof setEnabled, 'function')
  assert.equal(await setEnabled('on'), true)
  assert.equal(await setEnabled('off'), true)
  assert.deepEqual(commands, ['/quota-retry on', '/quota-retry off'])
})

check('a host without the command rejects the change instead of failing silently', async () => {
  const commands = []
  const context = createClientContext({
    session: createLiveSession(commands, { ok: true, value: { matched: false } }),
  })
  factoryResult.apply(context)
  const { setEnabled } = context.registrations[0].options.inject('probe-session')
  await assert.rejects(() => setEnabled('off'), /host offers no \/quota-retry command/)
  assert.deepEqual(commands, ['/quota-retry off'])
})

check('submitting before the session is materialized reports it', async () => {
  const context = createClientContext()
  factoryResult.apply(context)
  const { setEnabled } = context.registrations[0].options.inject('probe-session')
  await assert.rejects(() => setEnabled('on'), /not materialized yet/)
})

for (const { name, run } of checks) {
  await run()
  console.log(`ok  ${name}`)
}
console.log(`\n${checks.length} client probe checks passed`)
