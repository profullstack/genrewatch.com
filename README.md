# genrewatch.com

A release calendar for every genre. Follow a genre or a name — a show, a film, an
artist, a rocket — and get told before it is out.

Sibling to [tipoffwatch.com](https://tipoffwatch.com), which does the same thing for
sport. `/sports` here redirects there rather than being reimplemented thinly.

## The one idea that shapes everything

A sports fixture always has a kickoff. **A release very often has a date and no
time.** TMDB says a film opens on 16 December; MusicBrainz says an album is out in
2026 and nothing finer; The Space Devs says outright that a launch date is accurate
only to the month.

So every row carries `time_known` and `precision`, and that flag travels all the way
through:

| Layer | What it does with it |
|---|---|
| Adapters | Store an undated release at **noon UTC**, never midnight — midnight is the previous evening for the Americas |
| Scheduler | Two reminder classes: minute offsets (60, 1) for timed events, date offsets (1440, 0) for dated ones |
| Pages | Never print a clock for a time nobody announced; an undated row is visibly different |
| ICS | Emits an **all-day** `DTSTART;VALUE=DATE` entry, alarmed 09:00 on the day rather than 60 minutes before a noon anchor |
| RSS + API | Say "Out Friday 4 September", not "Starts 12:00:00 GMT" |

`precision` of `month` or `year` is browsable but **never remindable** — a
representative day is not a promise.

## The catalogue

`category → genre → subject → event`. A subject belongs to many genres (a show is
Drama *and* Sci-Fi *and* Thriller), so that edge is a join table, not a column.

| Category | Source | Key? | Notes |
|---|---|---|---|
| tv | TVmaze | no | `/schedule/full` returns the **entire** forward schedule in one request |
| anime | AniList | no | Real per-episode airing timestamps; 30–90 req/min |
| film | TMDB | free | The only key. Without it, film is skipped rather than broken |
| music | MusicBrainz | no | 1 req/sec, hard. See below |
| space | The Space Devs | no | **15 requests per hour**, for the whole deployment |
| sports | — | — | Redirects to tipoffwatch.com |

Cadence is per adapter and enforced against the **last completed sync** recorded in
the database (`genres.synced_at`), never against a job timer — a repeatable's timer
resets on every deploy, so on a busy day a timer-based sweep can be pushed forward
forever and never run.

### Music is thin, and that is honest

Measured against the live API on 2026-08-21, over a four-month forward window:

- MusicBrainz knows about **2,228** official releases.
- **11%** carry a day. The rest are "2026" or "2026-09".
- Of the artists behind those, **25%** have any genre tag.

The alternatives were measured too and are worse: Wikidata has 46 forward music
releases in *six* months, iTunes Search does not expose pre-orders at all, and
Deezer's genre-to-artist mapping files Bad Bunny under Rock. There is no free source
with volume, dates and genres together. Artist genres are resolved incrementally
(`MUSIC_LOOKUP_BUDGET` per pass) and cached — **including the negatives**, which is
what stops each pass re-asking about the same untagged artists.

### The IMDb backfill

The five adapters above answer *what is coming*. They do not answer *what exists* —
TMDB's back-catalogue walk is popularity-ordered and stops after a few thousand
films — and that gap is what makes a reader's own VOD folder unresolvable: a film
released last month sits in their folder, has no row here, and so has no page it
could be offered on.

So `packages/catalog/src/imdb.js` walks IMDb's daily dumps. Free, keyless,
`datasets.imdbws.com`, rebuilt every night.

- **It streams.** Production Postgres is internal to Railway with no public proxy,
  so this runs inside the container rather than through `psql \copy`, and the
  container cannot land a gigabyte on disk. Nothing bigger than one line is held.
- **It links before it inserts.** A candidate is matched against what we already
  hold on `(category, normalised title, year)`, so an IMDb row for a film TMDB
  already gave us enriches that row instead of creating a second page.
- **It is bounded and resumable.** A pass stops at `IMDB_DEADLINE_MS` and records
  the tconst it reached; the next resumes there. The first full walk takes a few
  nightly runs.

What it deliberately does **not** give you is a release date. `title.basics` carries
a start year and nothing finer, so these rows are `precision: 'year'`,
`time_known: false` — browsable, searchable and matchable against a playlist, never
alarmable. Anything with a real date still comes from TMDB, TVmaze or AniList, and
this pass never overwrites one.

Measured against the real dump on 2026-08-23: 1,708,507 rated titles, 428,513 above
100 votes (a 92MB map), and roughly 4% of `title.basics` rows kept. `tvEpisode` is
excluded outright — 8.5M rows, and an episode is only interesting through its show,
which TVmaze already gives us with a real air time.

| Knob | Default | What it is for |
|---|---|---|
| `IMDB_BACKFILL` | `1` | `0` turns the whole pass off without a deploy |
| `IMDB_MIN_VOTES` | `100` | A memory budget, not a taste one — the map scales with it |
| `IMDB_RECENT_YEARS` | `2` | Titles this new are kept with **no** votes. This is the half that fixes new releases |
| `IMDB_DEADLINE_MS` | `900000` | Wall-clock ceiling on one pass |

`bun run imdb` runs it by hand; `--deadline=60` gives it a minute instead of fifteen,
and `--restart` clears the cursor.

## Your own channel list

Optional, per account, and **private by default**. Add the M3U your provider already
gave you and the site tells you which of *your* entries is carrying something you
follow, and shows your provider's own `group-title` values as your own genre index
at `/my/channels`.

The playlist URL carries your credentials, so it is encrypted at rest and never
rendered into a page. VLC, Infuse and the `.m3u` download hand the entry straight to
your own player and never touch our servers. **"Play here"** is the exception, for a
television or a locked-down desktop with no app to hand a file to: it proxies the
bytes through the site, to your session only, never cached and never shared.

### Sharing a list

`user_playlists.shared` is an explicit, owner-set opt-out from the default. Two
facts shape what it can be:

- **The address is the credential.** So a shared entry plays through the proxy and
  nowhere else — no VLC link, no Infuse link, no `.m3u`. A shared list that also
  handed out the address would last as long as it took one person to paste one.
- **The connection ceiling belongs to the line, not the audience.** Slots are
  claimed against the *owner's* id, and a busy line refuses a stranger with a 409
  rather than evicting whoever is already watching. The owner is never locked out
  of their own line.

`/shared` lists who is sharing and how much, and nothing else — no titles, no
groups, no addresses.

## Running it

```sh
bun install
cp .env.example .env          # only DATABASE_URL is required
bun run migrate
bun run sync                  # seed the catalogue; --force ignores intervals
bun run dev
```

`bun test` runs the migrations and the scale-critical queries against a real
Postgres 18 in-process (PGlite) — no server, no Docker.

## Deployment

One container runs both roles; `ROLES=web,worker` picks which. Lives in the shared
"Profullstack, Inc." Railway project as service `genrewatch.com`, with its own
`Postgres-iVtY` and `Redis-wSsW`.

**`PORT` must match the domain's target port** (8080 here). With the app on 3000 and
the domain targeting 8080, every request 404s while the container reports healthy.

**`SITE_URL` is what every generated URL is built from** — canonicals, og:image, RSS
self-links, calendar feed URLs, notification click targets, every link in a reminder
email, and the passkey `rpID`. Changing it invalidates every passkey already
registered.
