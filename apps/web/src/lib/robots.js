import { config } from '@genre/config';
import { robotsTxt as gatewayRobots } from '@profullstack/x402-gateway/robots';

/**
 * robots.txt, built rather than typed, because a second site runs this code.
 *
 * Which crawlers pay and which read free is decided in one place, the gateway
 * package, and this file is generated from the same lists it enforces with.
 * The training crawlers it names get `Disallow: /` plus the one page that
 * sells them a pass; the retrieval crawlers -- the ones behind AI search
 * answers, which send a reader back -- get the wildcard rules, repeated under
 * their own names so that a crawler which obeys only the group matching its
 * name still stays off the sign-in page.
 *
 * AwarioBot was 47% of all requests, fetching /login about once a second from
 * a single address. It was told to stop here, re-read this file, and carried
 * on -- so app.js refuses it outright. Its group stays because a crawler that
 * later starts behaving will read it and comply without anyone having to
 * remember why.
 */

/**
 * Paths no crawler should index, in one list.
 *
 * They are the same page for every signed-out visitor, they carry nothing a
 * search result should point at, and /api/ answers callers rather than readers.
 */
const DISALLOW = ['/login', '/signup', '/auth/', '/api/'];

export {
  RETRIEVAL_AGENTS as RETRIEVAL,
  TRAINING_AGENTS as TRAINING,
} from '@profullstack/x402-gateway/agents';

export const robotsTxt = () =>
  gatewayRobots({ siteUrl: config.siteUrl, disallow: DISALLOW, refused: ['AwarioBot'] });
