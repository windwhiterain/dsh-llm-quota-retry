/**
 * Running one provider's balance script and holding what it last reported.
 *
 * A source is a command, run through the subprocess service the deployment
 * already has — never through a shell, and never through Node's own child
 * primitives — so the script's lifetime, its output bound, and its termination
 * are the harness's problem rather than this plugin's. The script owns its own
 * requests; this module forwards only the environment the row names explicitly
 * plus, when it names `apiKeyEnv`, the credential that reference resolves to at
 * that moment. It never writes a script's stdout into a log.
 *
 * That credential is resolved through the harness's own credential service, so a
 * key stored as an environment variable, in a `.env`, or in the credential store
 * all work the same way — and a key the user rotates reaches the next run, since
 * nothing here caches it.
 *
 * Every run is bounded and every failure is a *missing* reading rather than an
 * error: a provider whose script is broken, slow, or absent must not stop a
 * request, and the exhaustion mark on the provider is what keeps a spent
 * allowance out of the way in the meantime.
 *
 * @module dsh-llm-quota-retry/balance
 */

import { parseBalanceOutput } from './routes.js'

/** stdout cap for one script run: a reading is one small JSON object. */
const STDOUT_CAP_BYTES = 64 * 1024

/** stderr cap for one script run: kept only for the diagnostic line. */
const STDERR_CAP_BYTES = 8 * 1024

/** Grace the subprocess service may take to terminate a script it gave up on. */
const TERMINATION_GRACE_MS = 2_000

/**
 * Run one provider's balance script and record what it reported.
 *
 * The returned registry is the only thing that starts a script. It deduplicates
 * concurrent runs of the same provider, so a request-time decision and a
 * delegation-time decision never race two copies of one script.
 *
 * @param options - the subprocess and credential service lookups, the resolved
 *   balance sources, the route state that receives readings, a logger, and the
 *   plugin lifetime.
 * @param options.getSubprocess - reads the `subprocess` service, or undefined
 *   without it.
 * @param options.getCredentials - reads the `credentials` service, or undefined
 *   without it; a source naming `apiKeyEnv` cannot authenticate without it.
 * @param options.routes - the resolved route policy from `resolveRoutes`.
 * @param options.state - the route decision state readings are recorded in.
 * @param options.logger - the plugin's logger.
 * @param options.lifetime - aborts every run when the plugin unloads.
 * @returns the registry: `refresh` one provider, `refreshStale` every source
 *   that is due, and `dispose`.
 */
export function createBalanceRegistry({ getSubprocess, getCredentials, routes, state, logger, lifetime }) {
  /** provider -> the run in flight, so one script is never started twice. */
  const running = new Map()
  /** provider -> the last problem reported, so an unchanged failure logs once. */
  const problems = new Map()
  let warnedNoService = false

  /**
   * Report one provider's problem, once per distinct problem.
   * @param provider - the provider whose script failed.
   * @param problem - the diagnostic text.
   */
  function reportProblem(provider, problem) {
    if (problems.get(provider) === problem) return
    problems.set(provider, problem)
    logger.warn(`llm-quota-retry: balance script for "${provider}": ${problem}`)
  }

  /**
   * Forget one provider's last problem, so a later failure logs again.
   * @param provider - the provider whose script worked.
   */
  function clearProblem(provider) {
    problems.delete(provider)
  }

  /**
   * The environment one script run starts from: the row's explicit entries plus
   * the credential its `apiKeyEnv` names, resolved now so a rotated key reaches
   * this run.
   * @param source - the resolved balance source.
   * @returns the environment entries to merge onto the child's base.
   */
  async function environmentFor(source) {
    const forwarded = { ...source.env }
    if (source.apiKeyEnv === undefined) return forwarded
    let resolved
    try {
      resolved = await getCredentials()?.resolve(source.apiKeyEnv)
    } catch (error) {
      resolved = undefined
      reportProblem(source.provider, `credential ${source.apiKeyEnv} could not be resolved (${messageOf(error)})`)
    }
    if (resolved === undefined || resolved.value === '') {
      // The script still runs: it may read its own credential from a file, and
      // its own diagnostic is a better one than this plugin could invent.
      logger.warn(
        `llm-quota-retry: no credential is configured for ${source.apiKeyEnv} `
        + `(provider "${source.provider}"); its balance script runs without it`,
      )
      return forwarded
    }
    forwarded[source.apiKeyEnv] = resolved.value
    return forwarded
  }

  /**
   * Run one balance source now.
   * @param source - the resolved balance source.
   * @returns resolution once the reading was recorded or the run failed; never a
   *   rejection, because a failed reading is an answer, not an error.
   */
  async function run(source) {
    const provider = source.provider
    const subprocess = getSubprocess()
    if (subprocess === undefined || subprocess === null) {
      if (!warnedNoService) {
        warnedNoService = true
        logger.warn(
          'llm-quota-retry: the subprocess service is not mounted, so balance scripts cannot run '
          + 'and no provider reading is available',
        )
      }
      return
    }
    const environment = await environmentFor(source)
    const signal = AbortSignal.any([AbortSignal.timeout(source.timeoutMs), lifetime.signal])
    let handle
    try {
      handle = subprocess.spawn({
        argv: [...source.script],
        cwd: process.cwd(),
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: STDOUT_CAP_BYTES },
          stderr: { maxBytes: STDERR_CAP_BYTES },
        },
        graceMs: TERMINATION_GRACE_MS,
        signal,
        env: environment,
      })
    } catch (error) {
      reportProblem(provider, `could not start it (${messageOf(error)})`)
      return
    }
    let outcome
    try {
      outcome = await handle.done
    } catch (error) {
      reportProblem(provider, `could not be run (${messageOf(error)})`)
      return
    }
    const stdout = handle.collected.stdout?.readFrom(0).text ?? ''
    if (outcome.exitCode !== 0) {
      const stderr = (handle.collected.stderr?.readFrom(0).text ?? '').trim().split('\n')[0] ?? ''
      reportProblem(
        provider,
        `exited with ${outcome.exitCode === null ? `signal ${String(outcome.signal)}` : `code ${outcome.exitCode}`}`
        + `${stderr === '' ? '' : ` (${stderr})`}`,
      )
      return
    }
    const parsed = parseBalanceOutput(stdout)
    if (parsed.kind === 'invalid') {
      reportProblem(provider, `${parsed.reason}; expected {"remaining": <number>}`)
      return
    }
    clearProblem(provider)
    state.noteReading(provider, parsed.reading, Date.now())
    logger.debug(
      `llm-quota-retry: balance for "${provider}" is ${parsed.reading.remaining}`
      + `${source.unit === undefined ? '' : ` ${source.unit}`}`
      + `${parsed.reading.error === undefined ? '' : ` (${parsed.reading.error})`}`,
    )
  }

  /**
   * Refresh one provider's reading, reusing a run already in flight.
   * @param provider - the provider to read.
   * @returns resolution once this provider's run settled.
   */
  function refresh(provider) {
    const source = routes.balances.find(balance => balance.provider === provider)
    if (source === undefined) return Promise.resolve()
    const inFlight = running.get(provider)
    if (inFlight !== undefined) return inFlight
    const started = run(source).finally(() => { running.delete(provider) })
    running.set(provider, started)
    return started
  }

  /**
   * Run every source whose reading is missing or older than its own refresh
   * interval.
   *
   * The readings this returns are what a route is drawn from, so a source that has
   * not been asked within its own interval is asked again rather than answered for
   * from a reading of unknown age. A reading inside that interval needs no run at
   * all, which is what bounds how often the scripts start. `providers` narrows the
   * run to one pool's routes, so choosing a route never probes a provider that
   * pool cannot use.
   *
   * @param options - `providers` narrows the run to those providers' sources;
   *   absent, every configured source is considered.
   * @returns resolution once every run that was due settled.
   */
  function refreshStale({ providers } = {}) {
    const now = Date.now()
    const wanted = providers === undefined ? undefined : new Set(providers)
    const due = routes.balances.filter((source) => {
      if (wanted !== undefined && !wanted.has(source.provider)) return false
      const reading = state.readingOf(source.provider)
      return reading === undefined || now - reading.at >= source.refreshMs
    })
    return Promise.all(due.map(source => refresh(source.provider))).then(() => undefined)
  }

  return { refresh, refreshStale }
}

/**
 * Read one thrown value as a one-line diagnostic.
 * @param error - the thrown value.
 * @returns its message, or its string form.
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
