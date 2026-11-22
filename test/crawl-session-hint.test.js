import { beforeAll, expect, test } from 'bun:test';

/**
 * The crawl gateway must not trust a session cookie's mere presence
 * (x402-gateway 0.18.3 `sessionCookie`): GPTBot with a made-up cookie is
 * charged, exactly as without one.
 */
let app;
const cookieName = 'gw_session';
beforeAll(async () => {
  const env = { DATABASE_URL: 'postgres://localhost/genrewatch_unused' };
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] ||= v;
  }
  try {
    ({ app } = await import('../apps/web/src/app.js'));
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

const GPTBOT = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)';

const page = (cookie) =>
  app.request('/about', {
    headers: { 'user-agent': GPTBOT, accept: 'application/json', 'x-real-ip': '198.51.100.31', ...(cookie ? { cookie } : {}) },
  });

test('a declared crawler is offered a crawl pass', async () => {
  expect((await page()).status).toBe(402);
});

test('a forged session cookie does not exempt it', async () => {
  const res = await page(`${cookieName}=forged`);
  expect(res.status).toBe(402);
  expect(await res.text()).toContain('accepts');
});
