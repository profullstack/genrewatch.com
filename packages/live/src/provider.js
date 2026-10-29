/**
 * The reseller panel: the four calls we make against it, and nothing else.
 *
 * The protocol is @profullstack/stream-providers' ArgonTV reseller client:
 * `X-ApiKey`, the `/lines/:id` route, `{ lines, package }` for an extension, and
 * an `error: true` body that can arrive with a 200. Those were checked against
 * the live API on 2026-10-29; the bearer header this file used to send was
 * refused there ("Unauthorized"), so no line could have been opened.
 *
 * The base URL and key are read from config on every call rather than
 * snapshotted, for the reason config gives about CoinPay's keys. Nothing in here
 * is shown to a reader. The provider's name appears in the environment variable
 * names and here, and nowhere a buyer can see.
 */

import { createReseller } from '@profullstack/stream-providers/argontv';
import { config } from '@genre/config';

const settings = () => config.live.provider;

/** A client for this call, with the key and base URL config holds right now. */
function reseller(fetchImpl) {
  const { apiKey, baseUrl, templateId } = settings();
  if (!apiKey) throw new Error('the line provider is not configured');
  return createReseller({
    apiKey,
    baseUrl,
    templateId,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
}

/**
 * One call, for an operator's one-off.
 *
 * @param {string} path
 * @param {{method?: string, body?: object, fetchImpl?: typeof fetch}} [opts]
 */
export async function call(path, { method = 'GET', body, fetchImpl } = {}) {
  return reseller(fetchImpl).call(path, { method, body });
}

/**
 * Open a new line with `connections` in total (the API counts the ones beyond
 * the first). Returns the provider's id, the Xtream pair and the M3U address the
 * playlist importer will read.
 *
 * @param {{packageId: number, connections?: number, fetchImpl?: typeof fetch}} args
 * @returns {Promise<{id: number, username: string, password: string, m3u: string, expiresAt: Date|null}>}
 */
export async function createLine({ packageId, connections = 1, fetchImpl }) {
  const line = await reseller(fetchImpl).createLine({ packageId, connections });
  if (!line.m3u) throw new Error('line provider sent no credential');
  return {
    id: line.id,
    username: line.username,
    password: line.password,
    m3u: line.m3u,
    expiresAt: line.expiresAt,
  };
}

/**
 * Add a package's length to a line that exists. The panel answers with counts
 * rather than the new expiry, so the caller reads the line back afterwards.
 *
 * @param {{lineId: number, packageId: number, fetchImpl?: typeof fetch}} args
 */
export async function extendLine({ lineId, packageId, fetchImpl }) {
  return reseller(fetchImpl).extendLine({ lineId, packageId });
}

/**
 * What the panel currently says about a line.
 *
 * @param {{lineId: number, fetchImpl?: typeof fetch}} args
 */
export async function getLine({ lineId, fetchImpl }) {
  return reseller(fetchImpl).getLine(lineId);
}

/** Which bouquets the reseller account can issue. For an operator, not a page. */
export async function listTemplates({ fetchImpl } = {}) {
  return reseller(fetchImpl).templates();
}
