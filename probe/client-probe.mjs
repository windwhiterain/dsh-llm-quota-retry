#!/usr/bin/env node
/**
 * Offline probe for the Web composer half: loads `client.js` through a stub
 * module loader, runs its factory and `apply` against a fake Client context,
 * and renders the chips as plain functions to check what they offer.
 *
 * Run with `node probe/client-probe.mjs` from the package directory. Exits
 * non-zero on the first failed check.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createContext as createVmContext, runInContext } from 'node:vm'

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

/**
 * Render a chip as a plain function with the seats this slot provides.
 * @param component - the registered chip component.
 * @param facts - the `quotaRetry` projection the host would publish.
 * @param submit - stands in for whichever writer the chip injects.
 * @returns the element the chip renders.
 */
function render(component, facts, submit) {
  return component({
    useProjection: key => (key === 'quotaRetry' ? facts : undefined),
    setEnabled: submit,
    setPool: submit,
    t: (key, params) => key + (params === undefined ? '' : `(${Object.values(params).join(',')})`),
  })
}

/** The menu item ids a rendered chip offers. */
function optionIds(element) {
  return element.props.items.filter(item => typeof item.id === 'string').map(item => item.id)
}

/**
 * The trigger button a rendered chip hands its menu, built the way React would,
 * so the attributes and chrome the button itself carries are visible.
 * @param element - the element a chip rendered.
 * @returns the trigger button element.
 */
function triggerOf(element) {
  const anchor = element.props.anchor
  return typeof anchor.type === 'function' ? anchor.type(anchor.props) : anchor
}

/** The one slot registration a chip id owns. */
function registrationOf(context, id) {
  const found = context.registrations.find(registration => registration.options.id === id)
  assert.ok(found !== undefined, `no slot registration carries the id ${id}`)
  return found
}

check('apply registers its dictionary and both composer chips', async () => {
  const context = createClientContext()
  factoryResult.apply(context)
  assert.deepEqual(context.injections, ['conversation.input.left', 'conversation.input.left'])
  assert.equal(context.dictionaries.length, 1)
  assert.equal(context.dictionaries[0].ns, 'llmQuotaRetry')
  // Bilingual balance: the chips must ship both shipped locales.
  for (const locale of ['zh', 'en']) {
    assert.ok(context.dictionaries[0].dicts[locale] !== undefined, `missing the ${locale} dictionary`)
  }
  assert.equal(context.registrations.length, 2)
  assert.deepEqual(context.registrations.map(registration => ({
    name: registration.options.name,
    id: registration.options.id,
    order: registration.options.order,
    locale: registration.options.locale,
  })), [
    { name: 'conversation.input.left', id: 'llm-quota-retry', order: 31, locale: 'llmQuotaRetry' },
    { name: 'conversation.input.left', id: 'llm-quota-retry-pool', order: 32, locale: 'llmQuotaRetry' },
  ])
  for (const registration of context.registrations) {
    assert.equal(typeof registration.component, 'function')
  }
})

check('the chip is absent when the host publishes no projection', async () => {
  const context = createClientContext()
  factoryResult.apply(context)
  const { component } = context.registrations[0]
  assert.equal(render(component, undefined, async () => true), null)
})

check('the pool chip is absent when the host publishes no projection', async () => {
  const context = createClientContext()
  factoryResult.apply(context)
  const { component } = registrationOf(context, 'llm-quota-retry-pool')
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
  assert.equal(triggerOf(element).props['aria-label'], 'mode(state.off)')
})

check('an inherited setting is named as inherited and selects the value in force', async () => {
  const context = createClientContext()
  factoryResult.apply(context)
  const { component } = context.registrations[0]
  const element = render(component, { enabled: true, defaultEnabled: false, source: 'inherited' }, async () => true)
  assert.ok(optionIds(element).includes('inherited'))
  assert.equal(element.props.selectedId, 'on')
  assert.equal(triggerOf(element).props['aria-label'], 'mode(state.on)')
})

check('the deployment default is shown on the default option, not assumed off', async () => {
  const context = createClientContext()
  factoryResult.apply(context)
  const { component } = context.registrations[0]
  const element = render(component, { enabled: true, defaultEnabled: true, source: 'default' }, async () => true)
  const fallback = element.props.items.find(item => item.id === 'default')
  assert.equal(fallback.label.props.label, 'option.default(state.on)')
})

check('the pool menu offers every configured pool, default, and off, and marks the default', async () => {
  const context = createClientContext()
  factoryResult.apply(context)
  const { component } = registrationOf(context, 'llm-quota-retry-pool')
  const element = render(component, { pool: null, poolSource: 'default', pools: ['medium', 'fast'] }, async () => true)
  assert.equal(element.type, Menu)
  assert.deepEqual(optionIds(element), ['pool-heading', 'medium', 'fast', 'default', 'off'])
  assert.equal(element.props.selectedId, 'default')
  assert.equal(element.props.items[0].text, 'pool.menu.heading')
  // A pool row is the configured name itself; the two fixed rows carry the copy.
  assert.equal(element.props.items.find(item => item.id === 'fast').label.props.label, 'fast')
  assert.equal(element.props.items.find(item => item.id === 'default').label.props.label, 'pool.option.default')
  assert.equal(element.props.items.find(item => item.id === 'off').label.props.label, 'pool.option.off')
  assert.equal(element.props.anchor.props.label, 'pool.chip.default')
  assert.equal(triggerOf(element).props['aria-label'], 'pool.mode(option.defaultUnknown)')
})

check('an opted-out session marks off, and a named pool marks that pool', async () => {
  const context = createClientContext()
  factoryResult.apply(context)
  const { component } = registrationOf(context, 'llm-quota-retry-pool')
  const optedOut = render(component, { pool: null, poolSource: 'off', pools: ['medium'] }, async () => true)
  assert.deepEqual(optionIds(optedOut), ['pool-heading', 'medium', 'default', 'off'])
  assert.equal(optedOut.props.selectedId, 'off')
  assert.equal(optedOut.props.anchor.props.label, 'pool.chip.off')
  assert.equal(triggerOf(optedOut).props['aria-label'], 'pool.mode(state.off)')

  const chosen = render(component, { pool: 'fast', poolSource: 'session', pools: ['medium', 'fast'] }, async () => true)
  assert.equal(chosen.props.selectedId, 'fast')
  assert.equal(chosen.props.anchor.props.label, 'pool.chip.pool(fast)')
  assert.equal(triggerOf(chosen).props['aria-label'], 'pool.mode(fast)')
})

check('an inherited pool is named as inherited and selects the pool in force', async () => {
  const context = createClientContext()
  factoryResult.apply(context)
  const { component } = registrationOf(context, 'llm-quota-retry-pool')
  const element = render(component, { pool: 'fast', poolSource: 'inherited', pools: ['medium', 'fast'] }, async () => true)
  assert.ok(optionIds(element).includes('pool-inherited'))
  assert.equal(element.props.selectedId, 'fast')
  assert.equal(element.props.anchor.props.label, 'pool.chip.pool(fast)')
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

check('choosing a pool submits exactly /quota-pool with the option id', async () => {
  const commands = []
  const context = createClientContext({ session: createLiveSession(commands) })
  factoryResult.apply(context)
  const { setPool } = registrationOf(context, 'llm-quota-retry-pool').options.inject('probe-session')
  assert.equal(typeof setPool, 'function')
  assert.equal(await setPool('medium'), true)
  assert.equal(await setPool('default'), true)
  assert.equal(await setPool('off'), true)
  assert.deepEqual(commands, ['/quota-pool medium', '/quota-pool default', '/quota-pool off'])
})

check('a host without /quota-pool rejects the change instead of failing silently', async () => {
  const commands = []
  const context = createClientContext({
    session: createLiveSession(commands, { ok: true, value: { matched: false } }),
  })
  factoryResult.apply(context)
  const { setPool } = registrationOf(context, 'llm-quota-retry-pool').options.inject('probe-session')
  await assert.rejects(() => setPool('off'), /host offers no \/quota-pool command/)
  assert.deepEqual(commands, ['/quota-pool off'])
})

check('the pool copy ships every key in both languages with matching placeholders', async () => {
  const context = createClientContext()
  factoryResult.apply(context)
  const { dicts } = context.dictionaries[0]
  const keys = [
    'pool.chip.pool', 'pool.chip.default', 'pool.chip.off', 'pool.menu.heading',
    'pool.option.default', 'pool.option.off', 'pool.mode',
  ]
  const placeholders = text => [...text.matchAll(/\{(\w+)\}/gu)].map(match => match[1]).sort()
  for (const key of keys) {
    for (const locale of ['zh', 'en']) {
      assert.ok(dicts[locale][key] !== undefined && dicts[locale][key] !== '', `missing the ${locale} copy of ${key}`)
    }
    assert.deepEqual(placeholders(dicts.zh[key]), placeholders(dicts.en[key]),
      `${key} must carry the same placeholders in both languages`)
  }
  // The pool name is the one value the chip substitutes, in the trigger label
  // and in its accessible name.
  for (const key of ['pool.chip.pool', 'pool.mode']) {
    for (const locale of ['zh', 'en']) {
      assert.deepEqual(placeholders(dicts[locale][key]), ['pool'], `${key} must carry {pool} in ${locale}`)
    }
  }
})

check('the bundle declares nothing where the concatenated batch shares one scope', () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const stub = () => ({ window: { __ModuleLoader__: { load() {} } } })

  // A composer bundle that declares a top-level name hands it to every other
  // bundle in the same batch. Two bundles declaring one name is a SyntaxError
  // that fails the whole batch, so the bundle must evaluate twice in a row.
  const batch = createVmContext(stub())
  assert.doesNotThrow(
    () => runInContext(`${source}\n${source}`, batch, { filename: 'client.js x2' }),
    'two copies of the bundle must share one concatenated batch scope',
  )

  // Names the sibling composer bundle also declares: the exact pair that
  // failed the Web batch once already.
  const context = createVmContext(stub())
  runInContext(source, context, { filename: 'client.js' })
  const shared = ['NS', 'zh', 'en', 'ON_OPTION', 'OFF_OPTION', 'DEFAULT_OPTION', 'ERROR_OPTION', 'STEP_PERCENTS']
  for (const name of shared) {
    assert.equal(runInContext(`typeof ${name}`, context), 'undefined',
      `client.js leaked the top-level binding ${name} into the shared batch scope`)
  }
})

for (const { name, run } of checks) {
  await run()
  console.log(`ok  ${name}`)
}
console.log(`\n${checks.length} client probe checks passed`)
