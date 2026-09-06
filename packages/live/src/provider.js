/**
 * The reseller panel: the four calls we make against it, and nothing else.
 *
 * Bearer key, JSON in and out, and an `error: true` body that can arrive with a
 * 200 -- so both are checked. The base URL and key are read from config on every
 * call rather than snapshotted, for the reason config gives about CoinPay's keys.
 *
 * Nothing in here is shown to a reader. The provider's name appears in the
 * environment variable names and here, and nowhere a buyer can see.
 */

import { config } from '@genre/config';

const settings = () => config.live.provider;

/**
 * @param {string} path
 * @param {{method?: string, body?: object, fetchImpl?: typeof fetch}} [opts]
 */
export async function call(path, { method = 'GET', body, fetchImpl = fetch } = {}) {
  const { apiKey, baseUrl } = settings();
  if (!apiKey) throw new Error('the line provider is not configured');

  const res = await fetchImpl(`${baseUrl}${path}`, {
    method,
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new Error(`line provider answered ${res.status}: ${data.message ?? ''}`.trim());
  if (data.error === true) throw new Error(`line provider refused: ${data.message ?? 'no reason'}`);
  return data;
}

/**
 * Open a new line.
 *
 * `additional_cons` is connections BEYOND the one a line comes with; we ask for
 * what config wants minus that one. Returns the provider's id, the credential
 * pair and the M3U address the playlist importer will read.
 *
 * @param {{packageId: number, connections?: number, fetchImpl?: typeof fetch}} args
 * @returns {Promise<{id: number, username: string, password: string, m3u: string, expiresAt: Date|null}>}
 */
export async function createLine({ packageId, connections = 1, fetchImpl }) {
  const body = { package: packageId };
  const template = settings().templateId;
  if (template) body.template = template;
  const extra = Math.max(0, Math.trunc(connections) - 1);
  if (extra > 0) body.additional_cons = extra;

  const data = await call('/api/v1/create-line', { method: 'POST', body, fetchImpl });
  return lineFrom(data);
}

/**
 * Add a package's length to a line that exists.
 *
 * The panel answers with counts rather than the new expiry, so the caller reads
 * the line back afterwards rather than guessing at arithmetic the panel did.
 *
 * @param {{lineId: number, packageId: number, fetchImpl?: typeof fetch}} args
 */
export async function extendLine({ lineId, packageId, fetchImpl }) {
  const data = await call('/api/v1/extend', {
    method: 'POST',
    body: { lines: [lineId], package: packageId },
    fetchImpl,
  });
  if (!data.successful) throw new Error('line provider extended nothing');
  return data;
}

/**
 * What the panel currently says about a line.
 *
 * @param {{lineId: number, fetchImpl?: typeof fetch}} args
 */
export async function getLine({ lineId, fetchImpl }) {
  const data = await call(`/api/v1/line/${Number(lineId)}`, { fetchImpl });
  return {
    ...lineFrom(data),
    status: data.status ?? null,
    maxConnections: Number.isFinite(Number(data.max_connections))
      ? Number(data.max_connections)
      : null,
  };
}

/** Which bouquets the reseller account can issue. For an operator, not a page. */
export async function listTemplates({ fetchImpl } = {}) {
  const data = await call('/api/v1/templates', { fetchImpl });
  return data.templates ?? [];
}

/** The panel's timestamps are unix seconds. */
function lineFrom(data) {
  const id = Number(data.id);
  if (!Number.isFinite(id) || id < 1) throw new Error('line provider sent no line id');
  const username = data.xtream_codes_username ?? data.username;
  const password = data.xtream_codes_password ?? data.password;
  const m3u = data.m3u_download_link;
  if (!username || !password || !m3u) throw new Error('line provider sent no credential');
  const exp = Number(data.expiration_time);
  return {
    id,
    username: String(username),
    password: String(password),
    m3u: String(m3u),
    expiresAt: Number.isFinite(exp) && exp > 0 ? new Date(exp * 1000) : null,
  };
}
