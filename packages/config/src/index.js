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

    /**
     * Wall-clock ceiling on one music pass, in milliseconds.
     *
     * MusicBrainz is one request per second with unreliable response times, and
     * the sync walks providers in sequence -- so without a ceiling a bad
     * afternoon there delays every provider behind it. Three minutes is comfortably
     * more than a healthy pass needs and far less than a degraded one will take.
     */
    musicDeadlineMs: num('MUSIC_DEADLINE_MS', 180_000),

    /**
     * How deep to walk TMDB's back catalogue, in pages of twenty.
     *
     * 200 pages is 4,000 films and reaches well past anything a reader would
     * name -- page 20 of this ordering is The Empire Strikes Back and page 250 is
     * already titles nobody searches for. The remaining million are reachable by
     * search falling through to the provider live, so this number is about what
     * is worth holding, not about coverage.
     */
    backCataloguePages: num('BACK_CATALOGUE_PAGES', 200),

    /**
     * How far ahead the "out in the next few hours" list on /genres reaches.
     *
     * Nothing to do with syncing -- purely how much of the front of the calendar
     * that page shows. Four hours is roughly "the rest of an evening": long enough
     * to be worth checking before you settle down, short enough that the list is
     * still a list. Only rows with a real clock time are eligible, which on this
     * site is a minority (see time_known).
     */
    soonWindowHours: num('CATALOG_SOON_WINDOW_HOURS', 4),

    /*
     * The IMDb backfill.
     *
     * A different kind of source from the five adapters above: they answer "what
     * is coming", this answers "what exists". It is what makes a reader's own VOD
     * folder resolvable -- a film released last month is in their folder and, until
     * this ran, in no table here.
     *
     * On by default and free: datasets.imdbws.com needs no key and no account.
     * IMDB_BACKFILL=0 turns it off without a deploy.
     */
    imdbEnabled: opt('IMDB_BACKFILL', '1') !== '0',

    /**
     * How many votes a title needs before its age stops mattering.
     *
     * IMDb has ratings for about 1.5 million titles and the great majority have
     * single-digit vote counts -- student films, local television, things nobody
     * will search for. A hundred is a low bar that still removes the tail. Lower
     * it to hold more; the cost is rows, not requests.
     */
    imdbMinVotes: num('IMDB_MIN_VOTES', 100),

    /**
     * How many years back count as "new", regardless of votes.
     *
     * This is the half of the filter that exists for the actual problem. A film
     * released last month has almost no votes and would fail the threshold above,
     * and it is exactly the film sitting unmatched in somebody's VOD folder. Two
     * years is generous enough to cover a slow rating curve.
     */
    imdbRecentYears: num('IMDB_RECENT_YEARS', 2),

    /**
     * Wall-clock ceiling on one pass, in milliseconds.
     *
     * title.basics is eleven and a half million rows and does not fit in one
     * budget on a small container. A pass stops here and records the tconst it
     * reached; the next resumes from it. Fifteen minutes gets through a large
     * slice without holding a worker for an hour, and the first full walk takes a
     * few days of nightly runs -- after which each pass is a cheap re-read that
     * only writes what changed.
     */
    imdbDeadlineMs: num('IMDB_DEADLINE_MS', 15 * 60_000),
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
    /**
     * The key the stored playlist URL is encrypted with.
     *
     * PLAYLIST_SECRET when it is set, and otherwise derived from DATABASE_URL --
     * which works because DATABASE_URL is required, so there is always a key, and
     * because it is NOT stored in the database it protects. That is the whole
     * point of encrypting these: the threat is a copy of the database (a backup, a
     * dump pulled to a laptop), and a dump contains the sealed rows but not the
     * environment that can open them.
     *
     * The trade for that convenience: rotating the database credentials makes
     * stored lists unreadable, and every reader simply adds theirs again --
     * decryption returns null rather than garbage, so nothing breaks loudly. Set
     * PLAYLIST_SECRET explicitly to decouple the two.
     */
    get secret() {
      return opt('PLAYLIST_SECRET') || opt('DATABASE_URL');
    },
    /** Always on: there is no configuration left to forget. */
    get enabled() {
      return Boolean(this.secret);
    },
    /** Refuse a list bigger than this, in bytes. A real provider list is ~800KB. */
    maxBytes: num('PLAYLIST_MAX_BYTES', 8 * 1024 * 1024),
    /**
     * How often each list is re-fetched, in minutes.
     *
     * Five, because providers rewrite their numbered event slots close to airtime
     * and a stale title is a missed match. Know what it costs before lowering it
     * further: the measured provider supports no conditional request at all (no
     * ETag, no Last-Modified, If-Modified-Since answered with a full 200), so every
     * poll downloads the whole file. At five minutes that is 288 fetches and
     * roughly 230MB a day PER LIST, pulled from the reader's own subscription by a
     * datacenter IP. Content hashing spares the database but cannot spare the
     * download.
     *
     * Raise it if a provider starts objecting; that is the lever, and it needs no
     * deploy.
     */
    refreshMinutes: num('PLAYLIST_REFRESH_MINUTES', 5),

    /**
     * Playing a channel in the page itself, rather than handing it to an app.
     *
     * Ported from the sibling site, which is where the whole player comes from.
     * On by default, because the devices that most need it are the ones with no
     * app to hand a file to: a Fire TV, an Android TV, a desktop browser at work.
     * It has a switch anyway, and the switch is about MONEY rather than
     * correctness -- this is the only route on the site where a request costs
     * bandwidth by the gigabyte. A single 1080p stream runs 4-6 Mbps, so one
     * viewer watching one film moves roughly 2.5GB, and it is billed twice: in
     * from the provider and out to the reader. Everything else here is a byte
     * pipe by design precisely so that this is the only cost it can have.
     *
     * Set STREAM_PROXY=0 to take it away without a deploy; the VLC, Infuse and
     * .m3u buttons keep working, because they never went through us.
     */
    proxy: {
      get enabled() {
        return opt('STREAM_PROXY', '1') !== '0';
      },
      /**
       * Concurrent in-page streams per account.
       *
       * One, matching what a typical line permits. This exists to protect the
       * READER's subscription, not our capacity -- a provider that sees two
       * simultaneous connections from one credential suspends the account.
       *
       * At the ceiling the OLDEST stream is dropped, not the newest: pressing
       * Play on another channel says which channel is wanted now, so it takes the
       * line over. Raising this above 1 only makes sense for a line that really
       * permits more; it does not make the player better behaved.
       */
      maxPerUser: num('STREAM_PROXY_MAX_PER_USER', 1),
    },
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

  reminders: {
    /** Minutes before a timed event. The product promises 60 and 1. */
    defaultOffsets: opt('REMINDER_OFFSETS', '60,1')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0),
    /*
     * Minutes before an event that only has a DATE.
     *
     * A separate list because the sensible answers differ by two orders of
     * magnitude: an hour before a launch, the morning of an album. 1440 is the
     * day before and 0 is on the day, both measured against the noon-UTC anchor
     * the adapters store for an undated release -- noon rather than midnight so
     * the date lands inside the right calendar day for every reader rather than
     * the previous evening for the Americas.
     *
     * Zero is allowed here and rejected above: "at the moment it is out" is a
     * real choice for a release and a meaningless one for a timed event, which
     * already has its own 1-minute offset.
     */
    dateOffsets: opt('REMINDER_DATE_OFFSETS', '1440,0')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n >= 0),
    /** Subscribers pulled per fan-out page. Queue depth stays proportional to
     *  batches, not to followers -- see packages/queue. */
    batchSize: num('REMINDER_BATCH_SIZE', 500),
    /** A reminder later than this past its due moment is dropped, not sent late.
     *  Telling someone something starts in an hour, 40 minutes after it did, is worse
     *  than saying nothing. */
    maxLatenessSeconds: num('REMINDER_MAX_LATENESS_SECONDS', 300),
  },

  sync: {
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

  /**
   * Analytics, if this deployment has any.
   *
   * No default on purpose. A hardcoded site id would mean every deployment of
   * this codebase -- a fork, a staging copy, a sibling brand -- silently
   * reporting its traffic into someone else's dashboard, and the numbers would
   * be wrong in a way nobody would think to check.
   *
   * The id is not a secret; it is served in the HTML to every visitor. It lives
   * in configuration because it identifies the DEPLOYMENT, not because it needs
   * hiding.
   */
  analytics: {
    /* Read on use rather than snapshotted at import, like the playlist secret
       above and for the same reason: a value frozen when the module first loads
       cannot be changed by anything afterwards, which makes it untestable and
       makes the order modules happen to import in part of the behaviour. */
    get crawlproofSite() {
      return opt('CRAWLPROOF_SITE_ID');
    },
    get enabled() {
      return Boolean(this.crawlproofSite);
    },
  },

  /**
   * Network ads, if this deployment sells any.
   *
   * No default, for the reason the analytics id above has none: a hardcoded slot
   * travels with a clone and the wrong site starts earning -- or worse, serving
   * -- against someone else's inventory. Absent means no ad script is loaded at
   * all, not an empty box.
   */
  ads: {
    get slot() {
      return opt('CRAWLPROOF_AD_SLOT');
    },
    get enabled() {
      return Boolean(this.slot);
    },
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
