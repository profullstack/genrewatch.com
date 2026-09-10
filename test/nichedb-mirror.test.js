import { beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

process.env.DATABASE_URL = 'postgres://localhost:5432/unused';

const { adapters, categoriesOf } = await import('../packages/catalog/src/index.js');
const {
  CATEGORIES,
  PAGE_SIZE,
  detailFromTitle,
  eventFrom,
  imdbYearEvent,
  pageUrl,
  subjectFrom,
  sync,
  writeReleases,
  writeTitles,
} = await import('../packages/catalog/src/nichedb.js');
const { keyFor, slugify } = await import('../packages/catalog/src/slug.js');

/**
 * Mirroring nichedb's `screen` collection into the tables the pages already read.
 *
 * The contract this is written to is the item shape nichedb's adapters produce
 * and its read API serves, so the fixture is that shape -- id, kind, title,
 * published_at, tags, `data` -- and NOT this site's own row shape. What matters is
 * that a mirrored row lands on the SAME (provider, provider_key) the local
 * adapter would have written, so every slug and URL ever handed out still
 * resolves. That is asserted key by key below.
 *
 * The walk runs against an in-memory nichedb and an in-memory database, both
 * injected, because what is interesting about it -- resuming mid-walk, the
 * release gate, running twice -- is a property of the loop, not of Postgres.
 */

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/nichedb-screen.json', import.meta.url).pathname, 'utf8'),
);
const NOW = new Date('2026-09-10T12:00:00Z');
const byId = (id) => [...fixture.titles, ...fixture.releases].find((i) => i.id === id) ?? null;

/* ------------------------------------------------------------ the fakes ---- */

/**
 * The database, as the mirror sees it: the same functions, keyed the same way.
 *
 * Upserts are keyed on (provider, provider_key) exactly as the tables are, and
 * the coalesce rules that matter here (an established imdb_id or year wins) are
 * reproduced, because the link path depends on them.
 */
function fakeDb() {
  const genres = new Map();
  const subjects = new Map();
  const events = new Map();
  const subjectGenres = new Map();
  const eventGenres = new Map();
  const cursors = new Map();
  const detailWrites = [];
  let nextId = 1;
  const k = (provider, key) => `${provider}|${key}`;

  return {
    genres,
    subjects,
    events,
    subjectGenres,
    eventGenres,
    cursors,
    detailWrites,
    async upsertGenres(rows) {
      const out = new Map();
      for (const g of rows ?? []) {
        const id = genres.get(k(g.provider, g.providerKey))?.id ?? nextId++;
        genres.set(k(g.provider, g.providerKey), { ...g, id });
        out.set(g.providerKey, id);
      }
      return out;
    },
    async upsertSubjects(rows) {
      const out = new Map();
      for (const s of rows ?? []) {
        const prev = subjects.get(k(s.provider, s.providerKey));
        const id = prev?.id ?? nextId++;
        subjects.set(k(s.provider, s.providerKey), {
          ...prev,
          ...s,
          id,
          // Never reassigned by an ordinary upsert, as in the real table.
          slug: prev?.slug ?? s.slug,
          imdbId: prev?.imdbId ?? s.imdbId ?? null,
          year: prev?.year ?? s.year ?? null,
          tmdbId: prev?.tmdbId ?? s.tmdbId ?? null,
        });
        out.set(s.providerKey, id);
      }
      return out;
    },
    async replaceSubjectGenres(pairs) {
      for (const p of pairs ?? [])
        if (p.genreIds?.length) subjectGenres.set(p.subjectId, p.genreIds);
    },
    async upsertEvents(rows) {
      const out = new Map();
      for (const e of rows ?? []) {
        const prev = events.get(k(e.provider, e.providerKey));
        const id = prev?.id ?? nextId++;
        events.set(k(e.provider, e.providerKey), {
          ...prev,
          ...e,
          id,
          detail: e.detail ?? prev?.detail ?? null,
        });
        out.set(e.providerKey, id);
      }
      return out;
    },
    async replaceEventGenres(pairs) {
      for (const p of pairs ?? []) if (p.genreIds?.length) eventGenres.set(p.eventId, p.genreIds);
    },
    async subjectsByProviderKeys(keys) {
      const out = new Map();
      for (const s of subjects.values())
        if (keys.includes(s.providerKey)) out.set(s.providerKey, s);
      return out;
    },
    async subjectsByNormTitle(keys) {
      const out = new Map();
      const norms = new Set(keys.map((x) => x.normTitle).filter(Boolean));
      for (const s of subjects.values()) {
        if (!norms.has(s.normTitle)) continue;
        out.set(`${s.category} ${s.normTitle} ${s.year ?? ''}`, s.id);
      }
      return out;
    },
    async linkImdbToSubjects(rows) {
      for (const r of rows ?? []) {
        const s = [...subjects.values()].find((x) => x.id === r.subjectId);
        if (!s) continue;
        s.imdbId = s.imdbId ?? r.tconst;
        s.rating = s.rating ?? r.rating ?? null;
        s.ratingCount = s.ratingCount ?? r.ratingCount ?? null;
      }
      return rows.length;
    },
    async genreIdsForSubjects(ids) {
      const out = new Map();
      for (const id of ids) if (subjectGenres.has(id)) out.set(id, subjectGenres.get(id));
      return out;
    },
    async applyTitleDetailToEvents(rows) {
      for (const r of rows ?? []) {
        detailWrites.push(r);
        for (const e of events.values()) {
          if (e.subjectId === r.subjectId && e.provider === r.provider) {
            e.detail = e.detail ?? r.detail;
            e.trailerUrl = e.trailerUrl ?? r.trailerUrl;
          }
        }
      }
      return rows.length;
    },
    async nichedbCursor(kind) {
      return cursors.get(kind) ?? null;
    },
    async saveNichedbCursor(kind, c) {
      const prev = cursors.get(kind) ?? { pages: 0, items: 0 };
      cursors.set(kind, {
        kind,
        since: c.since ?? null,
        after_id: c.afterId ?? null,
        walk_started_at: c.walkStartedAt ?? null,
        walked_at: c.walkedAt ?? prev.walked_at ?? null,
        pages: prev.pages + (c.pages ?? 0),
        items: prev.items + (c.items ?? 0),
        note: c.note ?? null,
      });
    },
  };
}

/**
 * nichedb's read API, as far as the mirror uses it: `kind`, `since` on an
 * updated_at the wire never shows, keyset on `after`, id ascending, `limit`.
 * Counts requests, because the budget is the thing under test.
 */
function fakeNichedb(items) {
  const requests = [];
  const http = async (url) => {
    const u = new URL(url);
    requests.push(u);
    const kind = u.searchParams.get('kind');
    const after = Number(u.searchParams.get('after')) || 0;
    const since = u.searchParams.get('since') ? new Date(u.searchParams.get('since')) : null;
    const limit = Number(u.searchParams.get('limit')) || 50;
    const page = items
      .filter((i) => i.kind === kind && i.id > after)
      .filter((i) => !since || new Date(i._updatedAt ?? '2026-09-10T00:00:00Z') >= since)
      .sort((a, b) => a.id - b.id)
      .slice(0, limit);
    return { count: page.length, items: page };
  };
  return { http, requests };
}

/* -------------------------------------------------------------- mapping ---- */

describe('a title lands on the row the local adapter would have written', () => {
  test('a TMDB film keeps its provider, key and slug', () => {
    const { subject, genres } = subjectFrom(byId(100));
    expect(subject.provider).toBe('tmdb');
    expect(subject.providerKey).toBe(keyFor('tmdb', 'movie', '603'));
    expect(subject.providerKey).toBe('tmdb:movie:603');
    expect(subject.slug).toBe(slugify('Dune: Part Three', '603'));
    expect(subject).toMatchObject({
      category: 'film',
      kind: 'film',
      name: 'Dune: Part Three',
      displayName: 'Dune: Part Three',
      imageUrl: 'https://image.tmdb.org/t/p/w342/dune3.jpg',
      backdropUrl: 'https://image.tmdb.org/t/p/w780/dune3-wide.jpg',
      popularity: 512.3,
      year: 2026,
      rating: 8.1,
      ratingCount: 1200,
      normTitle: 'dune part three',
      tmdbId: '603',
      url: 'https://www.themoviedb.org/movie/603',
    });
    // The genre rows are TMDB's, with the `-film` slug suffix the adapter chose.
    expect(genres.map((g) => g.providerKey)).toEqual([
      keyFor('tmdb', 'genre', 'Science Fiction'),
      keyFor('tmdb', 'genre', 'Adventure'),
    ]);
    expect(genres[0]).toMatchObject({
      provider: 'tmdb',
      category: 'film',
      slug: 'science-fiction-film',
    });
    expect(subject.genreKeys).toEqual(genres.map((g) => g.providerKey));
  });

  /* imdb_id is unique across subjects and the IMDb rows own it. A TMDB or TVmaze
     row writing the same tconst would fail the whole chunk, as the local
     adapters never did. */
  test('only IMDb rows carry the tconst onto the subject', () => {
    expect(subjectFrom(byId(100)).subject.imdbId).toBeUndefined();
    expect(subjectFrom(byId(101)).subject.imdbId).toBeUndefined();
    expect(subjectFrom(byId(104)).subject.imdbId).toBe('tt0133093');
  });

  test('a TVmaze show', () => {
    const { subject, genres } = subjectFrom(byId(101));
    expect(subject).toMatchObject({
      provider: 'tvmaze',
      providerKey: 'tvmaze:show:44480',
      category: 'tv',
      kind: 'show',
      slug: slugify('Severance', '44480'),
      rating: 8.6,
      year: 2022,
    });
    expect(genres.map((g) => g.slug)).toEqual(['drama-tv', 'thriller-tv']);
  });

  /* The local TVmaze adapter dropped a show it had tagged anime rather than
     hold a second copy beside AniList's. Parity, not preference. */
  test('a TVmaze show filed under anime is dropped, as it was locally', () => {
    expect(subjectFrom(byId(102))).toBeNull();
  });

  test('an AniList series', () => {
    const { subject, genres } = subjectFrom(byId(103));
    expect(subject).toMatchObject({
      provider: 'anilist',
      providerKey: 'anilist:anime:21',
      category: 'anime',
      kind: 'anime',
      slug: slugify('One Piece', '21'),
      backdropUrl: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/op.jpg',
      rating: 8.8,
    });
    expect(genres.map((g) => g.slug)).toEqual(['action-anime', 'adventure-anime']);
  });

  test('a title with no genre is dropped for the three forward providers', () => {
    expect(subjectFrom(byId(107))).toBeNull();
  });
});

describe('an IMDb title becomes what the local backfill made of it', () => {
  test('a film: tconst key, readable slug, ratings and the year', () => {
    const { subject, genres } = subjectFrom(byId(104));
    expect(subject).toMatchObject({
      provider: 'imdb',
      providerKey: 'tt0133093',
      category: 'film',
      kind: 'film',
      slug: 'the-matrix-tt0133093',
      normTitle: 'the matrix',
      year: 1999,
      imdbId: 'tt0133093',
      rating: 8.7,
      ratingCount: 2000000,
      // Fame as popularity, so IMDb rows rank against TMDB rows.
      popularity: 2000000,
      url: 'https://www.imdb.com/title/tt0133093/',
    });
    expect(genres.map((g) => [g.providerKey, g.slug])).toEqual([
      ['action', 'imdb-action'],
      ['sci-fi', 'imdb-sci-fi'],
    ]);
  });

  test('a series is a show in tv', () => {
    expect(subjectFrom(byId(105)).subject).toMatchObject({ kind: 'show', category: 'tv' });
  });

  test('no genre is not a reason to drop it', () => {
    const { subject, genres } = subjectFrom(byId(106));
    expect(subject.providerKey).toBe('tt9999001');
    expect(genres).toEqual([]);
  });

  /* Through THIS site's normaliser: '' for a title in another script is the
     value the search box and the playlist matcher expect, and nichedb's null is
     not it. */
  test('a title with no Latin characters normalises to empty, not null', () => {
    const { subject } = subjectFrom(byId(108));
    expect(subject.normTitle).toBe('');
    expect(subject.slug).toBe('x-tt5311514');
  });

  test('a dated title gets the year-anchored event, an undated one does not', () => {
    const dated = imdbYearEvent(subjectFrom(byId(104)).subject, { now: NOW });
    expect(dated).toMatchObject({
      provider: 'imdb',
      providerKey: 'imdb:release:tt0133093',
      subjectKey: 'tt0133093',
      kind: 'release',
      precision: 'year',
      timeKnown: false,
      state: 'out',
      rating: 8.7,
      runtimeMin: 136,
    });
    expect(dated.startsAt.toISOString()).toBe('1999-01-01T12:00:00.000Z');
    expect(imdbYearEvent(subjectFrom(byId(106)).subject, { now: NOW })).toBeNull();
  });

  test('a future year is upcoming', () => {
    const s = { ...subjectFrom(byId(104)).subject, year: 2027 };
    expect(imdbYearEvent(s, { now: NOW }).state).toBe('upcoming');
  });
});

describe('a release lands on the event row the local adapter would have written', () => {
  const dune = byId(100);

  /* One film, three rows, keyed apart exactly as the streaming-dates pass keyed
     them -- and the stream key WITHOUT nichedb's service suffix, or the mirror
     would open a second streaming row beside the one already there. */
  test('the three TMDB release kinds map to the three local keys', () => {
    const [theatrical, digital, stream] = [200, 201, 202].map((id) =>
      eventFrom(byId(id), { title: dune, now: NOW }),
    );
    expect(theatrical.providerKey).toBe('tmdb:release:603');
    expect(digital.providerKey).toBe('tmdb:digital:603');
    expect(stream.providerKey).toBe('tmdb:stream:603');
    for (const e of [theatrical, digital, stream]) {
      expect(e).toMatchObject({
        provider: 'tmdb',
        category: 'film',
        subjectKey: 'tmdb:movie:603',
        kind: 'release',
        timeKnown: false,
        precision: 'day',
        state: 'upcoming',
        venueRegion: null,
        imageUrl: 'https://image.tmdb.org/t/p/w342/dune3.jpg',
        backdropUrl: 'https://image.tmdb.org/t/p/w780/dune3-wide.jpg',
        rating: 8.1,
        ratingCount: 1200,
      });
    }
    expect(theatrical.venue).toBe('Cinemas');
    expect(digital.venue).toBe('Rent or buy');
    expect(stream.venue).toBe('Disney+');
    expect(theatrical.startsAt.toISOString()).toBe('2026-12-18T12:00:00.000Z');
  });

  test('a detailed title fills the detail columns on its releases', () => {
    const e = eventFrom(byId(200), { title: dune, now: NOW });
    expect(e.tagline).toBe('Long live the fighters.');
    expect(e.trailerUrl).toBe('https://www.youtube.com/watch?v=abc123');
    expect(e.runtimeMin).toBe(166);
    expect(e.detail).toEqual({
      cast: ['Timothée Chalamet', 'Zendaya'],
      director: 'Denis Villeneuve',
      studios: ['Legendary Pictures'],
      language: 'English',
      // The page reads {name, kind}; nichedb's bare service name is flat-rate.
      watch: [{ name: 'Max', kind: 'flatrate' }],
      digital: '2027-02-16',
      streaming: { date: '2027-03-23', service: 'Disney+' },
      imdbId: 'tt15239678',
    });
  });

  test('an undetailed title yields no detail, so a coalesce cannot blank one', () => {
    expect(detailFromTitle(byId(107))).toBeNull();
    const e = eventFrom(byId(200), { title: null, now: NOW });
    expect(e.detail).toBeNull();
    expect(e.tagline).toBeNull();
  });

  test('a TVmaze episode', () => {
    const e = eventFrom(byId(203), { title: byId(101), now: NOW });
    expect(e).toMatchObject({
      provider: 'tvmaze',
      providerKey: 'tvmaze:episode:3707960',
      subjectKey: 'tvmaze:show:44480',
      category: 'tv',
      kind: 'season-premiere',
      name: 'Severance 3x01 — Hello, Ms. Cobel',
      shortName: 'Hello, Ms. Cobel',
      timeKnown: true,
      precision: 'minute',
      state: 'upcoming',
      venue: 'Apple TV+',
      venueRegion: 'Streaming',
      season: 3,
      number: 1,
      runtimeMin: 58,
      rating: 8.6,
      imageUrl: 'https://static.tvmaze.com/uploads/images/medium_landscape/sev301.jpg',
      backdropUrl: 'https://static.tvmaze.com/uploads/images/original_untouched/sev301.jpg',
    });
    expect(e.detail).toEqual({
      network: 'Apple TV+',
      language: 'English',
      status: 'Running',
      officialSite: 'https://tv.apple.com/show/severance',
    });
  });

  test('an AniList airing is keyed on the schedule id, as it was locally', () => {
    const e = eventFrom(byId(204), { title: byId(103), now: NOW });
    expect(e).toMatchObject({
      provider: 'anilist',
      providerKey: 'anilist:airing:401234',
      subjectKey: 'anilist:anime:21',
      category: 'anime',
      kind: 'episode',
      shortName: 'Episode 1140',
      timeKnown: true,
      precision: 'minute',
      venue: 'Toei Animation',
      venueRegion: 'Japan',
      number: 1140,
      runtimeMin: 24,
      trailerUrl: 'https://www.youtube.com/watch?v=op-trailer',
      imageUrl: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/op.jpg',
    });
    expect(e.detail).toEqual({ studios: ['Toei Animation'], format: 'TV', episodes: null });
  });

  test('an episode of a show this site does not file is dropped', () => {
    expect(eventFrom(byId(205), { now: NOW })).toBeNull();
  });

  test('a date in the past is out, not upcoming', () => {
    const e = eventFrom({ ...byId(200), published_at: '2020-01-01T12:00:00Z' }, { now: NOW });
    expect(e.state).toBe('out');
  });
});

/* -------------------------------------------------------------- the writes -- */

describe('writing a page of titles', () => {
  test('genres, subjects and edges are written; a linkable IMDb row links', async () => {
    const db = fakeDb();
    const r = await writeTitles(fixture.titles, { db, now: NOW });

    // Two dropped: the TVmaze anime show and the untagged TMDB film.
    expect(r.dropped).toBe(2);
    // The IMDb Severance matched the TVmaze Severance on (tv, severance, 2022).
    expect(r.linked).toBe(1);
    expect(r.created).toBe(3);
    const tvmazeSev = db.subjects.get('tvmaze|tvmaze:show:44480');
    expect(tvmazeSev.imdbId).toBe('tt11280740');
    expect(db.subjects.has('imdb|tt11280740')).toBe(false);

    // Every kept subject has its genre edges.
    for (const key of [
      'tmdb|tmdb:movie:603',
      'tvmaze|tvmaze:show:44480',
      'anilist|anilist:anime:21',
    ]) {
      expect(db.subjectGenres.get(db.subjects.get(key).id)?.length).toBe(2);
    }
    // And the IMDb film got its year event, the undated one did not.
    expect(db.events.has('imdb|imdb:release:tt0133093')).toBe(true);
    expect(db.events.has('imdb|imdb:release:tt9999001')).toBe(false);
    expect(r.events).toBe(2);
  });

  test('a detailed TMDB title pushes its detail onto the events that show it', async () => {
    const db = fakeDb();
    await writeTitles([byId(100)], { db, now: NOW });
    expect(db.detailWrites).toHaveLength(1);
    expect(db.detailWrites[0]).toMatchObject({
      provider: 'tmdb',
      runtimeMin: 166,
      tagline: 'Long live the fighters.',
    });
    expect(db.detailWrites[0].detail.watch).toEqual([{ name: 'Max', kind: 'flatrate' }]);
  });

  test('an IMDb row already held is updated, not linked away and not re-evented', async () => {
    const db = fakeDb();
    await writeTitles([byId(104)], { db, now: NOW });
    const first = db.subjects.get('imdb|tt0133093');
    const bumped = { ...byId(104), data: { ...byId(104).data, rating: 8.8 } };
    const r = await writeTitles([bumped], { db, now: NOW });
    expect(r.linked).toBe(0);
    expect(r.created).toBe(0);
    expect(r.subjects).toBe(1);
    expect(db.subjects.get('imdb|tt0133093').id).toBe(first.id);
    expect(db.subjects.get('imdb|tt0133093').rating).toBe(8.8);
  });
});

describe('writing a page of releases', () => {
  test('events resolve their subject and inherit its genres', async () => {
    const db = fakeDb();
    await writeTitles(fixture.titles, { db, now: NOW });
    const r = await writeReleases(fixture.releases, { db, now: NOW });

    expect(r.events).toBe(5);
    // The episode of the dropped anime show, dropped with it.
    expect(r.dropped).toBe(1);
    // The film whose title was never mirrored.
    expect(r.orphaned).toBe(1);
    expect(db.events.has('tmdb|tmdb:release:777')).toBe(false);

    const dune = db.subjects.get('tmdb|tmdb:movie:603');
    for (const key of ['tmdb:release:603', 'tmdb:digital:603', 'tmdb:stream:603']) {
      const e = db.events.get(`tmdb|${key}`);
      expect(e.subjectId).toBe(dune.id);
      expect(db.eventGenres.get(e.id)).toEqual(db.subjectGenres.get(dune.id));
    }
    const ep = db.events.get('tvmaze|tvmaze:episode:3707960');
    expect(ep.subjectId).toBe(db.subjects.get('tvmaze|tvmaze:show:44480').id);
  });
});

/* ------------------------------------------------------------- the walk ----- */

/** A screen collection: the fixture plus enough IMDb titles to need several pages. */
function bigCollection(extraTitles = 450) {
  const items = [...fixture.titles, ...fixture.releases];
  for (let i = 0; i < extraTitles; i++) {
    const tconst = `tt${String(7000000 + i)}`;
    items.push({
      id: 1000 + i,
      kind: 'title',
      title: `Bulk Title ${i}`,
      summary: null,
      url: `https://www.imdb.com/title/${tconst}/`,
      image_url: null,
      published_at: '2001-07-01T12:00:00.000Z',
      time_known: false,
      precision: 'year',
      tags: ['title', 'film', 'imdb', 'genre:drama'],
      data: {
        provider: 'imdb',
        category: 'film',
        form: 'movie',
        year: 2001,
        imdbId: tconst,
        genres: ['Drama'],
        rating: 6.5,
        ratingCount: 250,
        runtimeMin: 90,
      },
    });
  }
  return items;
}

const run = (server, db, over = {}) =>
  sync({
    log: () => {},
    http: server.http,
    db,
    now: () => NOW,
    baseUrl: 'https://nichedb.test',
    pagesPerPass: 100,
    deadlineMs: 60_000,
    ...over,
  });

describe('the walk', () => {
  test('asks by id, ascending, keyset on after, with the page ceiling', () => {
    const u = new URL(
      pageUrl({ baseUrl: 'https://nichedb.test', kind: 'title', since: NOW, after: 42 }),
    );
    expect(u.pathname).toBe('/api/v1/items');
    expect(u.searchParams.get('collection')).toBe('screen');
    expect(u.searchParams.get('kind')).toBe('title');
    expect(u.searchParams.get('sort')).toBe('id');
    expect(u.searchParams.get('order')).toBe('asc');
    expect(u.searchParams.get('limit')).toBe(String(PAGE_SIZE));
    expect(u.searchParams.get('after')).toBe('42');
    expect(u.searchParams.get('since')).toBe(NOW.toISOString());
  });

  test('a first pass with too small a budget stops mid-walk and records where', async () => {
    const server = fakeNichedb(bigCollection());
    const db = fakeDb();
    const r = await run(server, db, { pagesPerPass: 2 });

    expect(r.pages).toBe(2);
    expect(server.requests).toHaveLength(2);
    const cursor = db.cursors.get('title');
    expect(cursor.walk_started_at).toEqual(NOW);
    expect(cursor.after_id).toBe(1000 + 400 - 9 - 1);
    expect(cursor.walked_at).toBeNull();
    // Releases did not run: no title walk has completed yet.
    expect(db.cursors.has('release')).toBe(false);
    expect(r.walks.release).toBeUndefined();
    expect(db.events.size).toBeGreaterThan(0); // the IMDb year events only
    expect([...db.events.keys()].every((k) => k.startsWith('imdb|'))).toBe(true);
  });

  test('the next pass resumes from the recorded id rather than the top', async () => {
    const server = fakeNichedb(bigCollection());
    const db = fakeDb();
    await run(server, db, { pagesPerPass: 2 });
    const before = server.requests.length;

    const r = await run(server, db);
    const resumed = server.requests[before];
    expect(resumed.searchParams.get('kind')).toBe('title');
    expect(resumed.searchParams.get('after')).toBe('1390');
    expect(r.walks.title.resumed).toBe(true);
    expect(r.walks.title.drained).toBe(true);

    // 459 titles: three pages, the last one short. Then releases: one page.
    expect(server.requests).toHaveLength(before + 1 + 1);
    expect(db.subjects.size).toBe(3 + 3 + 450);
    expect(r.walks.release.drained).toBe(true);
    expect(db.events.has('tmdb|tmdb:stream:603')).toBe(true);
    expect(db.events.has('tvmaze|tvmaze:episode:3707960')).toBe(true);
    expect(db.events.has('anilist|anilist:airing:401234')).toBe(true);
  });

  test('a drained walk moves the floor to just before it began and clears the id', async () => {
    const server = fakeNichedb(bigCollection(0));
    const db = fakeDb();
    await run(server, db);
    for (const kind of ['title', 'release']) {
      const c = db.cursors.get(kind);
      expect(c.after_id).toBeNull();
      expect(c.walk_started_at).toBeNull();
      expect(c.walked_at).toEqual(NOW);
      // Ten minutes of overlap, so a row committed as the walk began is caught.
      expect(c.since).toEqual(new Date(NOW.getTime() - 10 * 60_000));
    }
  });

  test('at steady state a pass is one request per kind and asks since the floor', async () => {
    const server = fakeNichedb(bigCollection(0));
    const db = fakeDb();
    await run(server, db);
    const before = server.requests.length;
    const r = await run(server, db);
    expect(server.requests).toHaveLength(before + 2);
    expect(r.pages).toBe(2);
    for (const u of server.requests.slice(before)) {
      expect(u.searchParams.get('since')).toBe(new Date(NOW.getTime() - 10 * 60_000).toISOString());
      expect(u.searchParams.has('after')).toBe(false);
    }
  });

  test('only what changed since the floor is fetched on a later walk', async () => {
    const items = bigCollection(0);
    const server = fakeNichedb(items);
    const db = fakeDb();
    await run(server, db);
    // One title changed after the walk; everything else is older than the floor.
    for (const i of items) i._updatedAt = '2026-09-10T00:00:00Z';
    const changed = items.find((i) => i.id === 104);
    changed._updatedAt = '2026-09-10T12:30:00Z';
    changed.data = { ...changed.data, rating: 9.0 };

    const r = await run(server, db, { now: () => new Date(NOW.getTime() + 3600_000) });
    expect(r.walks.title.items).toBe(1);
    expect(db.subjects.get('imdb|tt0133093').rating).toBe(9.0);
  });

  /* Every write is an upsert keyed on (provider, provider_key), so a second
     walk over the same items is the same catalogue -- no second Drama, no second
     Dune, no second streaming row. */
  test('running twice over the same collection is idempotent', async () => {
    const server = fakeNichedb(bigCollection(0));
    const db = fakeDb();
    await run(server, db);
    const snapshot = {
      genres: [...db.genres.keys()].sort(),
      subjects: [...db.subjects.entries()].map(([k, v]) => [k, v.id, v.slug]).sort(),
      events: [...db.events.entries()].map(([k, v]) => [k, v.id, v.subjectId]).sort(),
    };
    // Force a full re-walk rather than a since-filtered one.
    db.cursors.clear();
    await run(server, db);
    expect([...db.genres.keys()].sort()).toEqual(snapshot.genres);
    expect([...db.subjects.entries()].map(([k, v]) => [k, v.id, v.slug]).sort()).toEqual(
      snapshot.subjects,
    );
    expect([...db.events.entries()].map(([k, v]) => [k, v.id, v.subjectId]).sort()).toEqual(
      snapshot.events,
    );
  });

  test('the deadline ends a pass without losing the cursor', async () => {
    const server = fakeNichedb(bigCollection());
    const db = fakeDb();
    let calls = 0;
    // The clock jumps past the deadline after the first page.
    const now = () => new Date(NOW.getTime() + (calls++ > 3 ? 120_000 : 0));
    const r = await run(server, db, { now, deadlineMs: 60_000 });
    expect(r.pages).toBe(1);
    expect(db.cursors.get('title').after_id).toBe(1190);
  });
});

/* ------------------------------------------------------------ the switch ---- */

describe('the provider switch', () => {
  test('the default list runs the five local adapters and no mirror', () => {
    const names = adapters(['tvmaze', 'anilist', 'tmdb', 'musicbrainz', 'spacedevs']).map(
      (a) => a.name,
    );
    expect(names).toEqual(['tvmaze', 'anilist', 'tmdb', 'spacedevs', 'musicbrainz']);
  });

  test('naming nichedb stands the screen adapters down even when they are named too', () => {
    const names = adapters([
      'tvmaze',
      'anilist',
      'tmdb',
      'nichedb',
      'musicbrainz',
      'spacedevs',
    ]).map((a) => a.name);
    expect(names).toEqual(['spacedevs', 'nichedb', 'musicbrainz']);
  });

  test('music and space are left alone either way', () => {
    expect(adapters(['nichedb', 'musicbrainz', 'spacedevs']).map((a) => a.name)).toEqual([
      'spacedevs',
      'nichedb',
      'musicbrainz',
    ]);
    expect(adapters(['nichedb']).map((a) => a.name)).toEqual(['nichedb']);
  });

  test('the mirror covers the three screen categories', () => {
    const entry = adapters(['nichedb'])[0];
    expect(categoriesOf(entry)).toEqual(['film', 'tv', 'anime']);
    expect(CATEGORIES).toEqual(['film', 'tv', 'anime']);
    expect(typeof entry.module.sync).toBe('function');
  });

  test('the spaceflight budget still runs before the mirror', () => {
    const names = adapters(['nichedb', 'spacedevs']).map((a) => a.name);
    expect(names.indexOf('spacedevs')).toBeLessThan(names.indexOf('nichedb'));
  });
});

describe('what stands down under the mirror', () => {
  const read = (p) => readFileSync(new URL(p, import.meta.url).pathname, 'utf8');

  test('the IMDb worker answers before reading its progress row', () => {
    const workers = read('../packages/queue/src/workers.js');
    const at = workers.indexOf('QUEUES.imdb');
    const body = workers.slice(at, workers.indexOf('new Worker(QUEUES.fanout'));
    expect(body.indexOf("includes('nichedb')")).toBeGreaterThan(-1);
    expect(body.indexOf("includes('nichedb')")).toBeLessThan(body.indexOf('q.imdbProgress()'));
  });

  test('and the pass itself refuses, for the CLI', () => {
    const imdb = read('../packages/catalog/src/imdb.js');
    const fn = imdb.slice(imdb.indexOf('export async function syncImdb'));
    expect(fn.slice(0, fn.indexOf('const startedAt'))).toContain("includes('nichedb')");
  });

  /* Every TMDB-only pass asks the switch, not the raw variable, so turning the
     mirror on stops every request to TMDB and not only the sweep. */
  test('the TMDB passes ask the switch rather than the raw variable', () => {
    const index = read('../packages/catalog/src/index.js');
    for (const name of ['syncDetail', 'syncImdbMeta', 'syncDigital', 'syncBackCatalogue']) {
      const fn = index.slice(index.indexOf(`export async function ${name}`));
      const head = fn.slice(0, fn.indexOf('\n\n'));
      expect(head, name).toContain("providerEnabled('tmdb')");
      expect(head, name).not.toContain('config.catalog.providers');
    }
  });
});

/* ------------------------------------------------------------- the table ---- */

describe('the cursor table', () => {
  let db;
  let queries;

  beforeAll(async () => {
    db = await new PGlite({ extensions: { citext, pg_trgm } });
    const dir = new URL('../packages/db/migrations/', import.meta.url).pathname;
    for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
      await db.exec(await readFile(dir + f, 'utf8'));
    }
    queries = await readFile(
      new URL('../packages/db/src/queries.js', import.meta.url).pathname,
      'utf8',
    );
  }, 60_000);

  test('exists, one row per kind', async () => {
    await db.query(`insert into nichedb_cursor (kind) values ('title')`);
    expect(db.query(`insert into nichedb_cursor (kind) values ('title')`)).rejects.toThrow();
  });

  /** The upsert as written in queries.js, with its interpolations numbered. */
  const lifted = () => {
    const at = queries.indexOf('export async function saveNichedbCursor');
    const open = queries.indexOf('sql`', at);
    let text = queries.slice(open + 4, queries.indexOf('`;', open));
    // Built without a `${` literal in the source, which biome reads as a mistake.
    const params = [
      'kind',
      'since ?? null',
      'afterId ?? null',
      'walkStartedAt ?? null',
      'walkedAt ?? null',
      'pages',
      'items',
      'note',
    ].map((e) => `$\{${e}}`);
    params.forEach((p, i) => {
      text = text.replace(p, `$${i + 1}`);
    });
    return text;
  };

  test('the counters accumulate and a drained stamp is never blanked by a mid-walk save', async () => {
    const save = (args) => db.query(lifted(), args);
    await save(['release', null, 300, '2026-09-10T12:00:00Z', null, 1, 200, 'walking']);
    await save([
      'release',
      '2026-09-10T11:50:00Z',
      null,
      null,
      '2026-09-10T13:00:00Z',
      1,
      40,
      'drained',
    ]);
    await save([
      'release',
      '2026-09-10T11:50:00Z',
      900,
      '2026-09-10T14:00:00Z',
      null,
      1,
      200,
      'walking',
    ]);
    const [row] = (await db.query(`select * from nichedb_cursor where kind = 'release'`)).rows;
    expect(row.pages).toBe(3);
    expect(row.items).toBe(440);
    expect(row.after_id).toBe(900);
    expect(new Date(row.walked_at).toISOString()).toBe('2026-09-10T13:00:00.000Z');
  });

  test('the genre lookup for events runs as written', async () => {
    const at = queries.indexOf('export async function genreIdsForSubjects');
    const open = queries.indexOf('sql`', at);
    const text = queries
      .slice(open + 4, queries.indexOf('`;', open))
      .replace(`$\{${'pgArray(ids)'}}`, '$1');
    const [g1, g2] = (
      await db.query(
        `insert into genres (category, provider, provider_key, slug, name)
         values ('film','tmdb','tmdb:genre:drama','drama-film','Drama'),
                ('film','tmdb','tmdb:genre:war','war-film','War') returning id`,
      )
    ).rows;
    const [s] = (
      await db.query(
        `insert into subjects (category, kind, provider, provider_key, slug, name, display_name)
         values ('film','film','tmdb','tmdb:movie:1','a-film-1','A','A') returning id`,
      )
    ).rows;
    await db.query(
      `insert into subject_genres (subject_id, genre_id, position) values ($1,$2,1),($1,$3,0)`,
      [s.id, g1.id, g2.id],
    );
    const rows = (await db.query(text, [`{${s.id}}`])).rows;
    expect(rows).toHaveLength(1);
    // In position order: War (0) before Drama (1).
    expect(rows[0].genre_ids.map(Number)).toEqual([Number(g2.id), Number(g1.id)]);
  });
});
