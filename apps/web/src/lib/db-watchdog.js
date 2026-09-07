/**
 * Notice when the connection pool has stopped handing out connections.
 *
 * On 2026-09-07 every page on the site hung forever while the container stayed
 * up, Postgres stayed healthy and Railway reported the service Online. The web
 * process had run for about 29 hours; in that time its Bun `SQL` pool
 * (`DB_POOL_MAX`, 12) lost every slot it had. A query issued from a request
 * queued for a connection that was never going to arrive, and Bun's pool has no
 * queue deadline -- `connectionTimeout` bounds opening a socket, not waiting for
 * a free one -- so the request never failed and never answered. `/healthz`,
 * robots.txt and the 402 the crawler wall serves all answered in milliseconds,
 * because none of them touch the database.
 *
 * That combination is the dangerous part. Every liveness signal this deployment
 * has was green: the process was alive and sleeping, the accept queue was empty,
 * Postgres held four connections and no locks, and a fresh pool opened inside the
 * same container ran `catalogueStats()` in 51ms. Only requests through the app's
 * own pool hung. Railway's `healthcheckPath` gates a new deploy and is never
 * re-run, so nothing was ever going to restart it. It took a person noticing the
 * site was down.
 *
 * So the probe here MUST go through the same pool the requests use. A separate
 * connection is exactly the thing that stayed healthy for 29 hours while readers
 * got nothing, and a watchdog built on one would have reported everything fine.
 *
 * What it does when it decides the pool is gone is exit. That reads as drastic
 * for a web server, and it is the cheapest correct move here: the failure is
 * process-local state that no request can repair, a restart demonstrably clears
 * it (this outage ended with `railway restart`), and Railway replaces the
 * container in about a minute. Hanging forever is not the safer option -- it is
 * the outage.
 */

/** Enough consecutive failures that a blip cannot trigger a restart. */
const DEFAULT_FAILURES = 3;

/**
 * @param {object} o
 * @param {(signal: AbortSignal) => Promise<unknown>} o.probe
 *   Runs a trivial query on the shared pool. Given a signal, but a pool that has
 *   stopped issuing connections will not observe it -- the timeout below is what
 *   actually bounds the wait.
 * @param {number} [o.intervalMs] gap between probes
 * @param {number} [o.timeoutMs] how long one probe may take before it counts as a failure
 * @param {number} [o.failures] consecutive failures before giving up
 * @param {(reason: string) => void} [o.onGiveUp] what to do when the pool is declared gone
 * @param {Console} [o.log]
 * @returns {{ stop: () => void, check: () => Promise<boolean> }}
 */
export function startDbWatchdog({
  probe,
  intervalMs = 30_000,
  timeoutMs = 10_000,
  failures = DEFAULT_FAILURES,
  // Non-zero: this is a crash, not a drain. Railway restarts it either way, but a
  // clean exit in the deploy log would read as the app choosing to stop.
  onGiveUp = () => process.exit(1),
  log = console,
} = {}) {
  if (typeof probe !== 'function') throw new TypeError('the watchdog needs a probe');

  let consecutive = 0;
  let stopped = false;
  let timer = null;

  /**
   * One probe. Resolves true if the pool answered inside the timeout.
   *
   * The timeout is a race rather than a rejection from the driver, because the
   * symptom being watched for is a promise that never settles at all. Waiting on
   * the query alone would hang the watchdog in precisely the case it exists for.
   */
  async function check() {
    const controller = new AbortController();
    let timeoutId;
    const expired = Symbol('timeout');
    try {
      const outcome = await Promise.race([
        probe(controller.signal).then(() => true),
        new Promise((resolve) => {
          timeoutId = setTimeout(() => resolve(expired), timeoutMs);
        }),
      ]);
      if (outcome === expired) {
        controller.abort();
        consecutive += 1;
        log.error(
          `[db-watchdog] pool did not answer in ${timeoutMs}ms (${consecutive}/${failures})`,
        );
      } else {
        // A success clears the count: the bar is CONSECUTIVE failures, so a slow
        // minute or a single dropped connection never costs a restart. The wedge
        // this watches for does not recover on its own, so it never clears.
        if (consecutive > 0) log.warn(`[db-watchdog] pool answered again after ${consecutive}`);
        consecutive = 0;
        return true;
      }
    } catch (err) {
      // A rejection is a healthier signal than a hang: the pool is still refusing
      // work, but it is refusing rather than swallowing. Counted the same.
      consecutive += 1;
      log.error(
        `[db-watchdog] pool probe failed (${consecutive}/${failures}): ${err?.message ?? err}`,
      );
    } finally {
      clearTimeout(timeoutId);
    }

    if (consecutive >= failures && !stopped) {
      stopped = true;
      clearInterval(timer);
      const reason =
        `[db-watchdog] the database pool has stopped issuing connections ` +
        `(${consecutive} probes in a row). Postgres itself may be fine -- this is the ` +
        `in-process pool. Exiting so the platform starts a container that can serve.`;
      log.error(reason);
      onGiveUp(reason);
    }
    return false;
  }

  timer = setInterval(check, intervalMs);
  // A watchdog is not a reason to hold the process open on its own.
  timer.unref?.();

  return {
    check,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
