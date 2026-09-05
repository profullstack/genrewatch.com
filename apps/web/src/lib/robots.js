import { config } from '@genre/config';

/**
 * robots.txt, built rather than typed, because a second site runs this code.
 *
 * Two kinds of AI crawler come here and only one of them ever sends a reader
 * back. Retrieval crawlers feed the live index that ChatGPT search, Perplexity,
 * Bing and Siri cite from; those are welcome everywhere a reader may go.
 * Training crawlers copy pages into a corpus that is baked into weights months
 * later with no link back -- and a schedule is stale on arrival, so what they
 * take is worthless to them and costs us the CPU. Meta's alone was 45,000 hits a
 * day on genrewatch, more than 95% of all traffic. Those are told to stay out.
 */

/**
 * Paths no crawler should index, in one list.
 *
 * They are the same page for every signed-out visitor, they carry nothing a
 * search result should point at, and /api/ answers callers rather than readers.
 */
const DISALLOW = ['/login', '/signup', '/auth/', '/api/'];

/**
 * Retrieval crawlers, named so their operators can see they are welcome.
 *
 * The trap this avoids: a crawler that finds a group matching its own name obeys
 * THAT group and ignores `User-agent: *` entirely. Naming one and then listing
 * the auth paths only under the wildcard would invite it straight into /login,
 * which is the exact traffic that made robots.txt necessary here. So every
 * named group gets the same rules, generated rather than repeated.
 *
 * Google-Extended stays welcome on purpose: it is Google's training token, but
 * Google documents it as also controlling grounding in the Gemini app, and a
 * citation from there is the whole reason to be crawlable by AI at all.
 */
export const RETRIEVAL = [
  'OAI-SearchBot',
  'ChatGPT-User',
  'Claude-SearchBot',
  'Claude-User',
  'PerplexityBot',
  'Perplexity-User',
  'Google-Extended',
  'Bingbot',
];

/**
 * Training-only crawlers. Each is the token its operator documents for the
 * corpus crawl, distinct from the retrieval one above: GPTBot vs OAI-SearchBot,
 * ClaudeBot vs Claude-SearchBot, meta-externalagent vs Meta-ExternalFetcher,
 * Applebot-Extended vs Applebot. Disallowing the -Extended token leaves Siri and
 * Spotlight's crawl untouched.
 */
export const TRAINING = [
  'GPTBot',
  'ClaudeBot',
  'anthropic-ai',
  'CCBot',
  'meta-externalagent',
  'FacebookBot',
  'Bytespider',
  'Applebot-Extended',
];

const welcome = (agent) =>
  [`User-agent: ${agent}`, 'Allow: /', ...DISALLOW.map((p) => `Disallow: ${p}`)].join('\n');

const refused = (agent) => `User-agent: ${agent}\nDisallow: /`;

/**
 * AwarioBot was 47% of all requests, fetching /login about once a second from a
 * single address. It was told to stop here, re-read this file, and carried on --
 * so app.js refuses it outright. Its group stays because a crawler that later
 * starts behaving will read it and comply without anyone having to remember why.
 */
export const robotsTxt = () =>
  [
    refused('AwarioBot'),
    '',
    ...TRAINING.map((a) => `${refused(a)}\n`),
    ...RETRIEVAL.map((a) => `${welcome(a)}\n`),
    welcome('*'),
    '',
    `Sitemap: ${config.siteUrl}/sitemap.xml`,
    '',
  ].join('\n');
