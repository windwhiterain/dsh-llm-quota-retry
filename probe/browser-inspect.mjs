#!/usr/bin/env node
/**
 * Live browser inspection for a running dsh Web host.
 *
 * Opens one authenticated dsh URL in a real browser, records console output and
 * page errors, reads the boot graph the shell received, and reports whether the
 * composer slot carries this plugin's chip.
 *
 * Environment:
 * - `DSH_BROWSER_URL` (required) — the authenticated `dsh web` URL, token included.
 * - `DSH_BROWSER_EXECUTABLE` (required) — the browser binary to drive.
 * - `DSH_PLAYWRIGHT_CORE` (optional) — `playwright-core` entry module. Defaults
 *   to the running profile's own copy, so the tool reuses the host's install.
 * - `DSH_BROWSER_ARTIFACTS` (optional) — directory for the screenshot and HTML dump.
 *
 * Exits non-zero when the page reports an error or the boot graph omits the
 * plugin, so a caller can treat it as a check.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Package id this tool inspects. */
const PACKAGE_ID = 'dsh-llm-quota-retry'

/** Slot the composer half registers into. */
const SLOT = 'conversation.input.left'

function requireEnv(name) {
  const value = process.env[name]
  if (value === undefined || value === '') throw new Error(`${name} is required`)
  return value
}

const url = requireEnv('DSH_BROWSER_URL')
const executablePath = requireEnv('DSH_BROWSER_EXECUTABLE')
const profileDir = process.env.DSH_PROFILE_DIR
const playwrightEntry = process.env.DSH_PLAYWRIGHT_CORE
  ?? (profileDir === undefined ? undefined : join(profileDir, 'node_modules', 'playwright-core', 'index.mjs'))
if (playwrightEntry === undefined) {
  throw new Error('DSH_PLAYWRIGHT_CORE is required when DSH_PROFILE_DIR is unset')
}
const artifacts = process.env.DSH_BROWSER_ARTIFACTS ?? '.dev-artifacts'

const { chromium } = await import(pathToFileURL(playwrightEntry).href)

const console_ = []
const pageErrors = []
const failedRequests = []

const browser = await chromium.launch({ executablePath, headless: true })
const page = await browser.newPage()
page.on('console', (message) => {
  console_.push({ type: message.type(), text: message.text() })
})
page.on('pageerror', (error) => {
  pageErrors.push(error.stack ?? String(error))
})
page.on('requestfailed', (request) => {
  failedRequests.push(`${request.url()} — ${request.failure()?.errorText ?? 'unknown'}`)
})

await page.goto(url, { waitUntil: 'load' })
await page.waitForTimeout(4000)

const probe = await page.evaluate((packageId) => {
  const boot = globalThis.__DSH_BOOT__
  const entries = Array.isArray(boot?.entries) ? boot.entries.map(entry => entry.id) : null
  const batches = Array.isArray(boot?.batches)
    ? boot.batches.map(batch => ({ phase: batch.phase, entries: batch.entries }))
    : null
  const text = document.body === null ? '' : document.body.innerText
  const composerRow = document.querySelector('[class*="composer"]')
  return {
    boot: boot === undefined ? null : { rev: boot.rev, entries, batches },
    hasPackageEntry: entries === null ? null : entries.includes(packageId),
    bodyHasChipText: /Quota retry|额度重试/u.test(text),
    composerRowPresent: composerRow !== null,
    bodyText: text.slice(0, 1200),
  }
}, PACKAGE_ID)

mkdirSync(artifacts, { recursive: true })
await page.screenshot({ path: join(artifacts, `${PACKAGE_ID}-page.png`), fullPage: true })
writeFileSync(join(artifacts, `${PACKAGE_ID}-dom.html`), await page.content(), 'utf8')

console.log('=== boot graph ===')
console.log(JSON.stringify(probe.boot, null, 2))
console.log(`\npackage entry present in __DSH_BOOT__: ${String(probe.hasPackageEntry)}`)
console.log(`composer row present:                  ${String(probe.composerRowPresent)}`)
console.log(`page text mentions the chip:           ${String(probe.bodyHasChipText)}`)
console.log(`\n=== console (${console_.length}) ===`)
for (const entry of console_) console.log(`[${entry.type}] ${entry.text.slice(0, 500)}`)
console.log(`\n=== page errors (${pageErrors.length}) ===`)
for (const error of pageErrors) console.log(error.slice(0, 1500))
console.log(`\n=== failed requests (${failedRequests.length}) ===`)
for (const failure of failedRequests) console.log(failure)
console.log(`\n=== page text ===\n${probe.bodyText}`)
console.log(`\nartifacts: ${artifacts}`)
console.log(`slot inspected: ${SLOT}`)

await browser.close()

if (pageErrors.length > 0 || probe.hasPackageEntry === false) process.exitCode = 1
