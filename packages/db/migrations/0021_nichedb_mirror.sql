-- Mirroring nichedb.dev's `screen` collection instead of polling four upstreams.
--
-- TMDB, TVmaze, AniList and the IMDb dumps are now fetched once, by nichedb, and
-- every site that wants them reads nichedb. This site keeps its own tables -- the
-- pages, the follows, the reminder scan and the playlist matcher all read subjects
-- and events, and none of that changes -- so what is added here is only the
-- bookkeeping a mirror needs: where it got to.
--
-- One row per item KIND (`title`, `release`), because the two are walked
-- separately. Titles are walked first and releases only once every title has been
-- seen at least once, so a release never arrives before the subject it belongs to.

/*
 * The cursor is two things, and neither is a count.
 *
 * `since` is the floor on nichedb's updated_at for the walk in progress (or the
 * next one): every item that changed at or after it is fetched. `after_id` is the
 * last nichedb item id written inside the current walk, so a walk that ran out of
 * its page budget resumes by asking for `id > after_id` rather than starting over.
 * The two together survive the thing a "resume after updated_at X" cursor cannot:
 * a bulk load stamps thousands of rows with the SAME updated_at, and a page of 200
 * can never move past a tie set that size.
 *
 * A NULL walk_started_at means no walk is in progress; the next pass starts one at
 * `since`. When a walk drains, `since` moves to the moment that walk STARTED (less
 * a little overlap), so anything that changed while it ran is caught next time.
 */
create table if not exists nichedb_cursor (
  kind            text primary key,
  since           timestamptz,
  after_id        bigint,
  walk_started_at timestamptz,
  -- When the last walk drained. Releases wait on the title row's being non-null.
  walked_at       timestamptz,
  -- Running totals for a human reading the row: how much has this mirror pulled.
  pages           bigint not null default 0,
  items           bigint not null default 0,
  note            text,
  updated_at      timestamptz not null default now()
);
