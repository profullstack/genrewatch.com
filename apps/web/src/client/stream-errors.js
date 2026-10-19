/**
 * What each way a channel can fail means, in words and in what to do next.
 *
 * The delivery is the house player's (@profullstack/player): its transport
 * stream engine rebuilds on failure, watches for a frozen clock, and refills
 * its budget on `playing`. What it cannot know is what THIS site's proxy meant
 * by a status. The proxy answers a failure with a status and a JSON reason,
 * and the reader sees neither: the request belongs to the library, which
 * reports a category and a status code. Reading the body instead would mean
 * issuing the request twice, and the second one is a second connection on a
 * line that counts them. So the code is mapped here, and each of these
 * corresponds to a branch of the route.
 *
 * `stop` is the server having decided something: reconnecting to be told the
 * same thing three times over is worse than being told once. `retry` rebuilds
 * on the engine's ladder and says `message` only once that is spent.
 */

/**
 * The same ladder, started further along, for a line we KNOW is busy.
 *
 * A generic network error is worth retrying immediately -- wifi came back, the
 * socket was replaced, two seconds is plenty. A 503 is different: the panel has
 * told us in words that it is still counting a connection, and the one it is
 * counting is usually the stream that just dropped. Reconnecting two seconds
 * later asks a question whose answer we already know, and spends an attempt to
 * hear it. Six seconds is roughly how long these panels take to notice a session
 * has ended, so the first attempt lands after that rather than during it.
 */
export const BUSY_BASE_MS = 6000;

const NETWORK_ERROR = 'NetworkError';

/**
 * @param {{ type: string, detail: string, code?: number }} failure
 * @returns {{ action: 'stop' | 'retry', message: string, delayMs?: number }}
 */
export function classifyStreamError({ type, detail, code }) {
  const stop = (message) => ({ action: 'stop', message });
  const retry = (message, delayMs) => ({
    action: 'retry',
    message,
    ...(delayMs ? { delayMs } : {}),
  });

  /*
   * A stream that stops sending never errors -- it just stops. The engine
   * notices the frozen clock and asks; it is worth a reconnect.
   */
  if (type === 'stall') return retry('The stream stopped sending. Try VLC, or press Play again.');

  // 429 is no longer a thing this route says -- starting a second channel now
  // takes the line over rather than being refused. Kept because something in
  // front of the app (a proxy, a WAF) can still say it, and "try again" is the
  // right advice for that, where "stop the other one" never was.
  if (code === 429) return stop('The line was busy. Try that again.');
  /*
   * Somebody else is watching a SHARED line.
   *
   * Only the shared route says this, and it says it rather than evicting. On a
   * reader's own line eviction is right -- pressing Play elsewhere says which
   * channel they want now. Taking a stranger's film off them because you
   * clicked something is a different act, so the shared route refuses and this
   * is the sentence that explains why.
   *
   * Reconnecting here would be worse than useless: more attempts on a line
   * somebody else is using is exactly the concurrency the provider suspends
   * accounts for.
   */
  if (code === 409)
    return stop('Somebody else is watching that line right now. Try again in a bit.');
  if (code === 404) return stop('That channel is no longer on your list.');
  if (code === 415) return stop('That channel needs a different player. Try VLC.');
  /*
   * The provider is not answering with video, and there are two very
   * different reasons for that.
   *
   * 502 is the route having established something about the SLOT: it served
   * an HTML apology, or the panel answered with a status that means the
   * channel is gone. Nothing about that improves on the second attempt, so
   * it is still final.
   *
   * 503 and 504 are the route having established something about the last
   * few seconds: a busy line, a panel having a bad minute, a connection that
   * did not open in time. Every one of those is the ordinary way a provider
   * behaves. They reconnect -- 503 further down the ladder,
   * because a busy line is the one failure whose cause we can name and wait out.
   */
  if (code === 502) return stop('Your provider did not send a stream for that channel.');
  if (code === 503) {
    return retry('Your provider kept the line busy. Try again in a minute.', BUSY_BASE_MS);
  }
  if (code === 504) return retry('Your provider did not send a stream for that channel.');
  if (type === NETWORK_ERROR) {
    /*
     * No status code, so this is the socket rather than the server: the line
     * dropped, wifi went, the provider hung up mid-stream. All three are worth
     * one more try, and on a stick they are the common case.
     */
    return retry(
      'The stream stopped. Your provider may have dropped it, or you started another channel somewhere else.',
    );
  }
  // Everything else is a demux or MSE failure, and the detail is the only
  // thing that distinguishes "this browser will not decode Dolby" from "the
  // stream changed shape halfway through". The second is recoverable by
  // rebuilding, the first is not -- and the engine's codec check has already
  // taken the first out, so this rebuilds and only reports if that fails too.
  return retry(
    detail
      ? `That stream could not be played here (${detail}). Try VLC.`
      : 'That stream could not be played here. Try VLC.',
  );
}
