-- Taking money, and turning exactly one settled payment into access.
--
-- Ported from the sibling brand's 0002_streams_payments.sql, minus its
-- `stream_offers` table. That one exists there to let a seller resell IPTV access
-- they hold; nothing in either codebase has ever INSERTed into it -- there is no
-- seller UI and no API to list an offer -- and reselling a film someone else owns
-- is not a thing this site is going to grow a marketplace for. The payment rail
-- itself is general, and that is what comes across.
--
-- The two tables below are deliberately the SAME SHAPE as the sibling's, because
-- packages/payments is copied between the two brands verbatim. A column that
-- differed here would be a difference that shared file cannot see.

create table if not exists payments (
  id           bigserial primary key,
  user_id      uuid not null references users(id) on delete cascade,
  provider     text not null default 'coinpay',
  -- The provider's own id. Unique so a replayed webhook credits nothing twice --
  -- this constraint IS the idempotency guarantee, not a tidiness measure.
  provider_ref text not null,
  amount_cents int not null,
  currency     text not null default 'USD',
  status       text not null default 'pending',
  raw          jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (provider, provider_ref)
);
create index if not exists payments_user_idx on payments (user_id);

create table if not exists entitlements (
  id         bigserial primary key,
  user_id    uuid not null references users(id) on delete cascade,
  event_id   bigint not null references events(id) on delete cascade,
  /*
   * Which offer was bought, when a brand has offers.
   *
   * A plain bigint with no foreign key, because the table it points at exists only
   * on the sibling. Keeping the column means the shared payments package writes the
   * same row shape in both brands; keeping it unconstrained means this brand does
   * not have to carry a resale table it will never populate.
   */
  offer_id   bigint,
  payment_id bigint references payments(id) on delete set null,
  status     text not null default 'active',
  /*
   * Access dies with the thing it was bought for, plus a grace window.
   *
   * There is no perpetual licence here and there is no default: grantEventEntitlement
   * refuses an entitlement without an expiry, because an open-ended grant is what
   * turns a small sale into redistribution.
   */
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  -- One entitlement per person per thing: re-buying is a no-op, not a double charge,
  -- and a replayed webhook cannot extend anybody's access.
  unique (user_id, event_id)
);
create index if not exists entitlements_event_idx on entitlements (event_id);
create index if not exists entitlements_expiry_idx on entitlements (expires_at)
  where status = 'active';
