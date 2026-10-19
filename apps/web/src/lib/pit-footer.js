/**
 * The pit.world network footer: one fragment (a scoped <style> plus a <nav
 * data-pit-footer>) fetched server-side and kept for an hour. A failed refresh
 * serves the last good copy; with no copy at all it renders nothing, so the page
 * never depends on pit.world being up.
 */
const URL_ = 'https://pit.world/snippets/footer.html?site=genrewatch.com';
const TTL_MS = 60 * 60 * 1000;

let cache = { html: '', fetchedAt: 0 };
let inflight = null;

const refresh = async () => {
  try {
    const res = await fetch(URL_, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`pit footer ${res.status}`);
    const html = await res.text();
    if (!html.includes('data-pit-footer')) throw new Error('pit footer: unexpected body');
    cache = { html, fetchedAt: Date.now() };
  } catch {
    // Stale on error; retry no sooner than a minute from now.
    cache = { html: cache.html, fetchedAt: Date.now() - TTL_MS + 60_000 };
  }
};

/** The fragment, or '' when pit.world has never answered. */
export const pitFooterHtml = async () => {
  if (Date.now() - cache.fetchedAt > TTL_MS) {
    inflight ??= refresh().finally(() => {
      inflight = null;
    });
    await inflight;
  }
  return cache.html;
};
