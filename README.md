# genrewatch.com

Sports calendar and reminder PWA. Follow any team in the world; get a web
notification and an email an hour before kickoff, and again one minute out.
Free for users.

## Stack

One Bun process, one Railway service, two managed datastores.

| Layer | Choice | Why |
|---|---|---|
| Runtime | Bun 1.3 | Web and workers share one runtime, so one container runs both |
| Web | Hono + `hono/jsx` SSR | Server-rendered; every control is a plain form and works with JS off |
| Data | Postgres | Write-heavy at viral scale: follows, fan-out claims, delivery receipts |
| Queue | BullMQ on Redis | Reminder fan-out, fixture sync, retries and backoff |
| Auth | Magic link + passkey | No passwords, so nothing to reset, rotate or leak |
| Fixtures | ESPN public JSON | 354 leagues / 17 sports, free and keyless |

## Running locally

```sh
cp .env.example .env      # fill in what you need; nothing is required to boot
docker compose up         # app + postgres + redis
bun run sync              # seed the catalogue and the first fortnight of fixtures
```

Without Docker, point `DATABASE_URL` and `REDIS_URL` at any Postgres and Redis
and run `bun run dev`.

## Layout

```
apps/web        Hono server, JSX views, PWA assets. Also boots the workers.
apps/worker     Same workers, standalone, for when one instance stops being enough.
packages/config Reads the environment. Nothing else touches process.env.
packages/db     Schema, forward-only migrations, and every query the app runs.
packages/sports Provider adapters. ESPN today; the interface takes others.
packages/queue  BullMQ queues, schedules and the fan-out workers.
packages/notify Web push (VAPID) and email (Resend).
packages/auth   Magic link, passkeys, sessions.
packages/payments CoinPay checkout, webhook verification, entitlements.
```

## How reminders scale

This is the part built for going viral, so it is worth stating plainly.

A naive implementation enqueues one job per follower when a game approaches. A
World Cup final with two million followers would enqueue two million jobs at
once and the queue becomes the outage.

Instead there are three tiers:

1. **Scan** (every 30s) finds events crossing a reminder threshold and enqueues
   one job per `(event, offset)` — job id `fo:<event>:<offset>`, so a scan that
   runs twice produces the same job rather than a second fan-out.
2. **Fan-out** pages that event's followers with a keyset cursor on `user_id`
   and enqueues one job per *page* of 500. Two million followers become four
   thousand jobs, and paging cost stays flat instead of degrading with `OFFSET`.
3. **Batch** claims and sends. The claim is an insert into `reminder_deliveries`
   whose primary key is `(event, user, offset, channel)`; a retried or duplicated
   job gets an empty set back and sends nothing.

Claiming happens **before** sending, so the worst case is a dropped notification
rather than a duplicate one — the right way round for something that buzzes a
phone at midnight. Reminders more than `REMINDER_MAX_LATENESS_SECONDS` past due
are dropped rather than delivered late.

## Fixture ingestion

ESPN publishes an unauthenticated JSON API. It is undocumented and carries no
SLA, which is exactly why every response is normalised and persisted immediately:
the calendar serves from our own tables, so an upstream outage degrades freshness
instead of blanking the site.

A whole date range comes back in one request, so a 14-day horizon costs one call
per league — a full sweep of 354 leagues is ~354 requests. That is why this runs
free where a live-scores vendor would charge $129/mo: schedules are cheap, live
scores are what you pay for.

Responses cap at ~100 events, so `fetchSchedule` splits the window and re-fetches
when it hits the cap — a truncated response is otherwise indistinguishable from a
quiet fortnight and would silently drop half a busy league's season.

## Deploying

One Railway service from the Dockerfile, plus managed Postgres and Redis.
`ROLES` decides what an instance runs (`web`, `worker`, or both — the default).
Migrations apply themselves on boot behind an advisory lock, so a deploy needs no
manual step.

Never hardcode a port: Railway injects `PORT`, and a fixed `-p` leaves the edge
proxy forwarding to a closed socket while the container reports healthy.

Secrets belong on the service and in the logicsrc vault, not in a committed
`.env`.
