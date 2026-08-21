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

## Your own channel list

Optional, private, per account. Add the M3U your provider already gave you and the
site tells you which of *your* channels is carrying something you follow, and shows
your provider's own `group-title` values as your own genre index at `/my/channels`.

Nothing is pooled, relayed or resold. The playlist URL carries your credentials, so
it is encrypted at rest and the hand-off is a one-channel file your own player
opens — nothing streams through GenreWatch.

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
