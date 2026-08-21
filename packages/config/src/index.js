/**
 * One place that reads the environment, so no other module ever touches process.env.
 *
 * Everything is read once at import. A missing *required* variable throws here, at boot,
 * rather than at the moment a customer clicks something -- which is the failure mode we
 * keep hitting when secrets live in scattered `process.env.X ?? fallback` reads.
 */

/** @param {string} name @param {string} [fallback] */
function req(name, fallback) {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') throw new Error(`Missing required env var ${name}`);
  return v;
}

/** @param {string} name @param {string} [fallback] */
const opt = (name, fallback = '') => process.env[name] ?? fallback;

/** @param {string} name @param {number} fallback */
const num = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`env ${name} must be a number, got ${raw}`);
  return n;
};

/** @param {string} name @param {boolean} fallback */
const bool = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
};

export const config = {
  env: opt('NODE_ENV', 'development'),
  isProd: opt('NODE_ENV', 'development') === 'production',

  /** Railway injects PORT. Never hardcode it -- a fixed port makes every request 404
   *  behind the edge proxy while the container still reports healthy. */
  port: num('PORT', 3000),

  /** Public origin. Passkey rpID is derived from this, so changing it invalidates
   *  every credential already registered. */
  siteUrl: opt('SITE_URL', 'http://localhost:3000').replace(/\/$/, ''),

  /**
   * No fallback, deliberately.
   *
   * Giving `req` a default defeats the only thing it does. A service deployed
   * without DATABASE_URL then silently dialled localhost and died several seconds
   * later with `ERR_POSTGRES_CONNECTION_CLOSED` — a Postgres error that says
   * nothing about the actual problem, which is a missing variable. Failing here
   * names it.
   */
  databaseUrl: req('DATABASE_URL'),

  /** Redis genuinely is optional: without it the cache degrades to hitting Postgres. */
  redisUrl: opt('REDIS_URL', 'redis://localhost:6379'),

  /** Which roles this process runs. One Railway service runs "web,worker"; splitting
   *  them later is a variable change, not a code change. */
  roles: opt('ROLES', 'web,worker')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  catalog: {
    /**
     * Which adapters run, by name, in registry order.
     *
     * Named rather than derived so a provider can be taken out of the rotation
     * without a deploy that touches code -- which matters more here than on a
     * single-source site, because these five fail independently and one of them
     * (spacedevs) fails for a whole hour at a time when it fails at all.
     */
    providers: opt('CATALOG_PROVIDERS', 'tvmaze,anilist,tmdb,musicbrainz,spacedevs')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),

    /** The only adapter that needs a key, and it is free. Film is skipped without it. */
    tmdbKey: opt('TMDB_API_KEY'),

    /** How far ahead to keep the calendar populated. */
    horizonDays: num('CATALOG_HORIZON_DAYS', 120),

    /**
     * Artist genre lookups MusicBrainz may be asked for in one pass.
     *
     * At one request per second this is also, near enough, the pass's duration in
     * seconds. 60 fills the backlog over a few days and then costs almost nothing,
     * because the answers -- including the negative ones -- are cached in the
     * database. Raising it does not make music better faster; MusicBrainz simply
     * does not have tags for most of these artists yet.
     */
    musicLookupBudget: num('MUSIC_LOOKUP_BUDGET', 60),
  },

  /**
   * A reader's own channel list.
   *
   * Strictly personal: one list per account, never pooled, never shown to anyone
   * else, and never wired to the resale offers. The playlist URL carries the
   * reader's provider credentials in its path, so it is encrypted at rest -- and
   * without a secret to encrypt it with, the feature turns itself off rather than
   * storing credentials in the clear.
   */
  playlists: {
    get secret() {
      return opt('PLAYLIST_SECRET');
    },
    get enabled() {
      return Boolean(this.secret);
    },
    /** Refuse a list bigger than this, in bytes. A real provider list is ~800KB. */
    maxBytes: num('PLAYLIST_MAX_BYTES', 8 * 1024 * 1024),
  },

  push: {
    publicKey: opt('VAPID_PUBLIC_KEY'),
    privateKey: opt('VAPID_PRIVATE_KEY'),
    subject: opt('VAPID_SUBJECT', 'mailto:hello@genrewatch.com'),
    get enabled() {
      return Boolean(this.publicKey && this.privateKey);
    },
  },

  mail: {
    resendKey: opt('RESEND_API_KEY'),
    from: opt('MAIL_FROM', 'GenreWatch <alerts@genrewatch.com>'),
    get enabled() {
      return Boolean(this.resendKey);
    },
  },

  coinpay: {
    /** Must be a MERCHANT api key (cp_live_/cp_test_ + 32 hex). An OAuth client id
     *  (cp_ + 24 hex) authenticates but cannot create payments -- it fails only at
     *  checkout, which is why this is asserted at boot rather than trusted. */
    /* Read on use rather than snapshotted at import. These three are only ever
       touched inside a request, and snapshotting them made the value depend on which
       module imported config first -- which turned the webhook signature tests into a
       coin flip decided by the rest of the suite. */
    get apiKey() {
      return opt('COINPAY_API_KEY');
    },
    get businessId() {
      return opt('COINPAY_BUSINESS_ID');
    },
    get webhookSecret() {
      return opt('COINPAY_WEBHOOK_SECRET');
    },
    baseUrl: opt('COINPAY_BASE_URL', 'https://coinpayportal.com'),
    get enabled() {
      return Boolean(this.apiKey && this.businessId && this.webhookSecret);
    },
  },

  reminders: {
    /** Minutes before kickoff. The product promises 60 and 1. */
    defaultOffsets: opt('REMINDER_OFFSETS', '60,1')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0),
    /** Subscribers pulled per fan-out page. Queue depth stays proportional to
     *  batches, not to followers -- see packages/queue. */
    batchSize: num('REMINDER_BATCH_SIZE', 500),
    /** A reminder later than this past its due moment is dropped, not sent late.
     *  Telling someone a game starts in an hour 40 minutes after kickoff is worse
     *  than saying nothing. */
    maxLatenessSeconds: num('REMINDER_MAX_LATENESS_SECONDS', 300),
  },

  sync: {
    /**
     * Hours before the FULL fixture sweep counts as overdue at boot.
     *
     * 24, matching its repeatable. It was 6 when the sweep itself ran every 6
     * hours; the near-window pass now carries the freshness that cadence was
     * buying, at a fifth of the requests, so the sweep only has to cover what
     * genuinely moves on a slower clock -- rosters, display names, and fixtures
     * further out than the day after tomorrow.
     */
    staleHours: num('SYNC_STALE_HOURS', 24),
    /**
     * Sweep on the next boot whatever the clock says.
     *
     * The escape hatch for the case the staleness check cannot cover: code that
     * reads a NEW field from the provider ships, every league was swept an hour
     * ago, and so nothing is due for another five -- during which the new column
     * is null everywhere and the feature looks broken. Turn it on, deploy, turn it
     * off. Left on, it sweeps once per boot, which is ~354 upstream requests.
     */
    onBoot: bool('SYNC_ON_BOOT', false),
  },

  cache: {
    /** Schedule pages are identical for every visitor, so they are rendered once and
     *  served from Redis. Personalisation is layered client-side. */
    scheduleTtlSeconds: num('CACHE_SCHEDULE_TTL', 60),
    enabled: bool('CACHE_ENABLED', true),
  },

  session: {
    cookie: 'gw_session',
    ttlDays: num('SESSION_TTL_DAYS', 90),
  },
};

/** Asserted at boot by whichever process is about to depend on it. */
export function assertCoinpayMerchantKey() {
  const k = config.coinpay.apiKey;
  if (!k) return;
  const merchant = /^cp_(live|test)_[0-9a-f]{32}$/.test(k);
  if (!merchant) {
    throw new Error(
      'COINPAY_API_KEY is not a merchant API key. Expected cp_live_/cp_test_ + 32 hex. ' +
        'An OAuth client id (cp_ + 24 hex) grants identity only and cannot create payments.',
    );
  }
}
