/**
 * The pit.world network footer: one fragment (a scoped <style> plus a <nav
 * data-net-footer>) fetched server-side and kept for an hour. Whatever a
 * successful response says is cached, even an empty body; any error (non-2xx,
 * timeout, network) renders nothing and is retried a minute later, so the page
 * never depends on pit.world being up.
 */
const URL_ = 'https://pit.world/snippets/footer.html?site=genrewatch.com';
const TTL_MS = 60 * 60 * 1000;
const RETRY_MS = 60 * 1000;

let cache = { html: '', expiresAt: 0 };
let inflight = null;

const refresh = async () => {
  try {
    const res = await fetch(URL_, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`pit footer ${res.status}`);
    const html = (await res.text()).trim();
    cache = { html, expiresAt: Date.now() + TTL_MS };
  } catch {
    cache = { html: '', expiresAt: Date.now() + RETRY_MS };
  }
};

/** The fragment, or '' when unavailable. */
export const pitFooterHtml = async () => {
  if (Date.now() >= cache.expiresAt) {
    inflight ??= refresh().finally(() => {
      inflight = null;
    });
    await inflight;
  }
  return cache.html;
};
