-- What the crawler paywall is actually doing, and who is on the other side.
--
-- The gateway has been answering 402 and selling day passes for a while, and
-- none of it was written down: a sale existed only for as long as the response
-- took to send. So there is no way to answer "what did the paywall earn this
-- month" or "which agent is the customer", which are the only two questions
-- that matter about it.
--
-- Two tables, because there are two facts. A sale is money. A demand is an
-- agent hitting the wall and not paying, which is the pipeline, and there are
-- thousands of those a day: it is counted per agent per day rather than stored
-- per request, so the table stays small enough to leave on forever.
create table if not exists crawl_sales (
  id          bigserial primary key,
  payer       text,
  ref         text unique,
  days        int not null default 1,
  price_cents int not null,
  total_cents int not null,
  currency    text not null default 'USD',
  user_agent  text,
  expires_at  timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists crawl_sales_payer_idx on crawl_sales (lower(payer), created_at desc);

create table if not exists crawl_demand (
  agent   text not null,
  day     date not null,
  hits    bigint not null default 0,
  primary key (agent, day)
);

-- Badges for the public board. Everything else it shows is projected out of
-- the two tables above; a badge is awarded at a moment and then kept, and that
-- fact lives nowhere else.
create table if not exists leaderboard_badges (
  player     text not null,
  badge      text not null,
  awarded_at timestamptz not null default now(),
  primary key (player, badge)
);
