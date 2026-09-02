import { beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { homeReleaseEvents, homeReleases } from '../packages/catalog/src/tmdb.js';

/**
 * When a film reaches the reader's own television.
 *
 * The calendar knew one date per film -- the day it opened in cinemas -- which is
 * a date most readers cannot act on. The complaint that produced this was exactly
 * that: a release calendar without streaming access is close to useless, because
 * it lists films you are told about and still cannot watch.
 *
 * The fixtures below are real /movie/{id}/release_dates responses, trimmed to the
 * US block. They are real on purpose: every interesting property of this parser is
 * a property of TMDB's actual data, and a hand-written fixture would quietly
 * assert the shape I expected rather than the one that arrives.
 */

/** Toy Story 5. Cinemas in June, buyable in August, on Disney+ in September. */
const TOY_STORY = {
  results: [
    {
      iso_3166_1: 'GB',
      release_dates: [{ type: 3, release_date: '2026-06-19T00:00:00.000Z', note: '' }],
    },
    {
      iso_3166_1: 'US',
      release_dates: [
        { type: 1, release_date: '2026-06-09T00:00:00.000Z', note: 'Los Angeles, California' },
        { type: 3, release_date: '2026-06-19T00:00:00.000Z', note: '' },
        { type: 4, release_date: '2026-08-18T00:00:00.000Z', note: '' },
        { type: 4, release_date: '2026-09-23T00:00:00.000Z', note: 'Disney+' },
        { type: 5, release_date: '2026-09-22T00:00:00.000Z', note: '4K Ultra HD / Blu-ray / DVD' },
      ],
    },
  ],
};

/** Backrooms. The same shape, plus a type-6 TV date that must not be mistaken
 *  for streaming: a broadcast is not something you can start when you like. */
const BACKROOMS = {
  results: [
    {
      iso_3166_1: 'US',
      release_dates: [
        { type: 3, release_date: '2026-05-29T00:00:00.000Z', note: '' },
        { type: 4, release_date: '2026-07-14T00:00:00.000Z', note: '' },
        { type: 4, release_date: '2026-09-25T00:00:00.000Z', note: 'HBO Max' },
        { type: 6, release_date: '2026-09-26T00:00:00.000Z', note: 'HBO' },
      ],
    },
  ],
};

describe('the two dates a home release is made of', () => {
  /*
   * The distinction this whole feature turns on. These are five weeks apart for
   * Toy Story 5, and answering with either one alone is wrong for half the
   * readers: the August date costs money, the September one is included in a
   * subscription they are already paying for.
   */
  test('a purchase date and a subscription date are kept apart', () => {
    const got = homeReleases(TOY_STORY);
    expect(got.vod).toBe('2026-08-18');
    expect(got.streaming).toEqual({ date: '2026-09-23', service: 'Disney+' });
  });

  test('the service is carried, because "Digital" alone answers nothing', () => {
    expect(homeReleases(BACKROOMS).streaming.service).toBe('HBO Max');
  });

  /* A broadcast is not on-demand access. Labelling one "Streaming" would tell a
     reader they can watch it whenever they like, which is the opposite of true. */
  test('a TV airdate is not a streaming date', () => {
    const got = homeReleases(BACKROOMS);
    expect(got.streaming.date).toBe('2026-09-25');
    expect(got.vod).toBe('2026-07-14');
  });

  test('a physical disc is not one either', () => {
    // 22 September, and nowhere in the answer.
    const got = homeReleases(TOY_STORY);
    expect(JSON.stringify(got)).not.toContain('2026-09-22');
  });

  test('only the named region is read', () => {
    // The GB block carries a theatrical date and no digital one at all.
    expect(homeReleases(TOY_STORY, { region: 'GB' })).toEqual({ vod: null, streaming: null });
  });

  test('a film with no digital date yet says so, rather than guessing', () => {
    const inCinemasOnly = {
      results: [
        { iso_3166_1: 'US', release_dates: [{ type: 3, release_date: '2026-12-16', note: '' }] },
      ],
    };
    expect(homeReleases(inCinemasOnly)).toEqual({ vod: null, streaming: null });
  });

  test('nothing at all is an answer, not a crash', () => {
    for (const bad of [null, undefined, {}, { results: [] }, { results: null }]) {
      expect(homeReleases(bad)).toEqual({ vod: null, streaming: null });
    }
  });

  /*
   * The note is the only thing separating the two dates, and most notes are
   * service names. So the test that matters is the other direction: a note that
   * describes the WINDOW must not be mistaken for a service called "Digital HD".
   */
  test('a note describing the window is not read as a service', () => {
    const noted = {
      results: [
        {
          iso_3166_1: 'US',
          release_dates: [{ type: 4, release_date: '2026-08-18', note: 'Digital HD' }],
        },
      ],
    };
    const got = homeReleases(noted);
    expect(got.vod).toBe('2026-08-18');
    expect(got.streaming).toBeNull();
  });

  /*
   * The row production actually wrote, and the reason the format branch exists.
   *
   * "Subtitled Version" is a description of the cut, not a place to watch it, and
   * the first version of this shipped it to the calendar as a film streaming on a
   * service called Subtitled Version. Notes like it are open-ended -- extended,
   * uncut, the 40th anniversary edition -- so they are caught on the descriptive
   * word rather than by enumerating phrases, and the date falls back to being one
   * you pay for.
   */
  test('a note describing the cut is not a service', () => {
    const subtitled = {
      results: [
        {
          iso_3166_1: 'US',
          release_dates: [{ type: 4, release_date: '2026-12-25', note: 'Subtitled Version' }],
        },
      ],
    };
    const got = homeReleases(subtitled);
    expect(got.streaming).toBeNull();
    expect(got.vod).toBe('2026-12-25');
  });

  test('and neither are the other shapes those notes take', () => {
    const noteFor = (note) =>
      homeReleases({
        results: [
          { iso_3166_1: 'US', release_dates: [{ type: 4, release_date: '2026-12-25', note }] },
        ],
      });
    for (const note of [
      "Director's Cut",
      '40th Anniversary Edition',
      'Extended Version',
      'Remastered',
      'IMAX',
      'Dubbed',
      'Re-release',
    ]) {
      expect(noteFor(note).streaming).toBeNull();
      expect(noteFor(note).vod).toBe('2026-12-25');
    }
  });

  /* The other direction still has to work, or the fix above trades one wrong
     answer for a worse one: every service filed as a rental. */
  test('but a real service is still recognised', () => {
    for (const service of ['Netflix', 'Disney+', 'HBO Max', 'Prime Video', 'Peacock', 'MUBI']) {
      const got = homeReleases({
        results: [
          {
            iso_3166_1: 'US',
            release_dates: [{ type: 4, release_date: '2026-12-25', note: service }],
          },
        ],
      });
      expect(got.streaming).toEqual({ date: '2026-12-25', service });
    }
  });

  test('the earliest of several is the one taken', () => {
    const many = {
      results: [
        {
          iso_3166_1: 'US',
          release_dates: [
            { type: 4, release_date: '2026-11-02', note: 'Netflix' },
            { type: 4, release_date: '2026-10-07', note: 'Netflix' },
            { type: 4, release_date: '2026-09-30', note: '' },
            { type: 4, release_date: '2026-10-30', note: '' },
          ],
        },
      ],
    };
    const got = homeReleases(many);
    expect(got.vod).toBe('2026-09-30');
    expect(got.streaming.date).toBe('2026-10-07');
  });

  /* A film that goes straight to a service never had a purchase window. */
  test('a service date with no purchase date stands alone', () => {
    const original = {
      results: [
        {
          iso_3166_1: 'US',
          release_dates: [{ type: 4, release_date: '2026-10-07', note: 'Netflix' }],
        },
      ],
    };
    expect(homeReleases(original)).toEqual({
      vod: null,
      streaming: { date: '2026-10-07', service: 'Netflix' },
    });
  });
});

describe('the calendar rows they become', () => {
  const base = {
    name: 'Toy Story 5',
    summary: 'A blurb.',
    imageUrl: 'https://image.tmdb.org/t/p/w342/poster.jpg',
    backdropUrl: 'https://image.tmdb.org/t/p/w780/back.jpg',
    url: 'https://www.themoviedb.org/movie/1084244',
    rating: 7.4,
    ratingCount: 812,
  };
  const events = homeReleaseEvents({
    providerId: '1084244',
    home: homeReleases(TOY_STORY),
    base,
  });

  /*
   * The reason the theatrical key was namespaced in the first place. Three rows
   * for one film share a trailing id and must not share a key, or each pass
   * overwrites the last and the film has one date again.
   */
  test('neither row can collide with the theatrical one', () => {
    const keys = events.map((e) => e.providerKey);
    expect(keys).toEqual(['tmdb:digital:1084244', 'tmdb:stream:1084244']);
    expect(keys).not.toContain('tmdb:release:1084244');
  });

  test('both point at the same film as the theatrical row', () => {
    for (const e of events) expect(e.subjectKey).toBe('tmdb:movie:1084244');
  });

  /* The venue is what tells the two apart in a list, so it has to say which is
     which -- "Toy Story 5 · Disney+" against "Toy Story 5 · Rent or buy". */
  test('each row says where, in the reader’s terms', () => {
    expect(events.map((e) => e.venue)).toEqual(['Rent or buy', 'Disney+']);
  });

  test('the dates are the ones parsed, anchored at noon UTC', () => {
    expect(events[0].startsAt.toISOString()).toBe('2026-08-18T12:00:00.000Z');
    expect(events[1].startsAt.toISOString()).toBe('2026-09-23T12:00:00.000Z');
  });

  /*
   * Date-only, exactly like the theatrical row it was built from. A streaming
   * drop has no announced minute either, and claiming one would put these in the
   * hourly reminder class and fire "in 60 minutes" against a noon anchor nobody
   * chose.
   */
  test('neither claims an hour nobody announced', () => {
    for (const e of events) {
      expect(e.timeKnown).toBe(false);
      expect(e.precision).toBe('day');
    }
  });

  test('the artwork and blurb are carried, so the page is not a stub', () => {
    for (const e of events) {
      expect(e.name).toBe('Toy Story 5');
      expect(e.imageUrl).toBe(base.imageUrl);
      expect(e.backdropUrl).toBe(base.backdropUrl);
      expect(e.summary).toBe('A blurb.');
    }
  });

  test('a date already past is stored as out, not as upcoming', () => {
    const [past] = homeReleaseEvents({
      providerId: '9',
      home: { vod: '2001-01-01', streaming: null },
      base,
    });
    expect(past.state).toBe('out');
  });

  test('a film with no home dates produces no rows', () => {
    expect(
      homeReleaseEvents({ providerId: '9', home: { vod: null, streaming: null }, base }),
    ).toEqual([]);
  });
});

/* ------------------------------------------------------------------ sync -- */

describe('asking again, because the answer arrives late', () => {
  const catalog = readFileSync(
    new URL('../packages/catalog/src/index.js', import.meta.url).pathname,
    'utf8',
  );
  const queries = readFileSync(
    new URL('../packages/db/src/queries.js', import.meta.url).pathname,
    'utf8',
  );

  /*
   * The timing bug this pass exists to avoid.
   *
   * A digital date does not exist when a film is first swept -- it is announced
   * weeks after the film opens. The detail pass asks once and stamps the answer
   * forever, so reusing its stamp would ask every film the question at the one
   * moment the answer is guaranteed to be absent, and the calendar would fill up
   * with cinema dates and nothing else. The whole feature would be silently
   * empty, which is the shape of bug worth pinning down.
   */
  test('the home-release stamp is its own column, not the detail one', () => {
    const fn = queries.slice(queries.indexOf('export async function eventsNeedingDigitalCheck('));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body).toContain('digital_checked_at');
    expect(body).not.toContain('detail_synced_at');
  });

  test('and it is re-checkable rather than once-only', () => {
    const fn = queries.slice(queries.indexOf('export async function eventsNeedingDigitalCheck('));
    expect(fn.slice(0, fn.indexOf('\n}\n'))).toContain('staleDays');
  });

  /* Otherwise the pass would ask what a streaming date's streaming date is. */
  test('only theatrical rows are asked about', () => {
    const fn = queries.slice(queries.indexOf('export async function eventsNeedingDigitalCheck('));
    expect(fn.slice(0, fn.indexOf('\n}\n'))).toContain("'tmdb:release:%'");
  });

  /*
   * The regression the new rows would otherwise have caused.
   *
   * The detail pass keys pending events by the trailing TMDB id. Once a film has
   * three rows sharing that id, a one-to-one map keeps only the last: its
   * siblings are stamped as answered while never being written to, so a streaming
   * page stays blank forever however many passes run. The map has to hold a list.
   */
  test('one film with three rows enriches all three', () => {
    const fn = catalog.slice(catalog.indexOf('export async function syncDetail('));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body).toContain('byId.get(d.providerId) ?? []');
    expect(body).toContain('flatMap');
  });

  test('a pass stamps what it asked about, found or not', () => {
    const fn = catalog.slice(catalog.indexOf('export async function syncDigital('));
    expect(fn.slice(0, fn.indexOf('\n}\n'))).toContain('markDigitalChecked');
  });

  /* A genre page is one index scan over denormalised rows, so an event with no
     genre edges is correct, stored, and unreachable from every page that matters. */
  test('the new rows inherit the genres of the film', () => {
    const fn = catalog.slice(catalog.indexOf('export async function syncDigital('));
    expect(fn.slice(0, fn.indexOf('\n}\n'))).toContain('copyEventGenres');
  });

  test('the pass is scheduled, or it would never run at all', () => {
    const queue = readFileSync(
      new URL('../packages/queue/src/index.js', import.meta.url).pathname,
      'utf8',
    );
    const workers = readFileSync(
      new URL('../packages/queue/src/workers.js', import.meta.url).pathname,
      'utf8',
    );
    expect(queue).toContain("{ kind: 'digital' }");
    expect(workers).toContain("job.data?.kind === 'digital'");
  });
});

/* -------------------------------------------------------------------- sql -- */

describe('which films get asked again', () => {
  let db;
  let subjectId;

  beforeAll(async () => {
    db = await new PGlite({ extensions: { citext, pg_trgm } });
    const dir = new URL('../packages/db/migrations/', import.meta.url).pathname;
    for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
      await db.exec(await readFile(dir + f, 'utf8'));
    }

    const [s] = (
      await db.query(
        `insert into subjects (category, kind, provider, provider_key, slug, name, display_name,
                               search_text)
         values ('film','film','tmdb','tmdb:movie:1','toy','Toy Story 5','Toy Story 5','toy')
         returning id`,
      )
    ).rows;
    subjectId = s.id;

    const ev = async (key, monthsAgo, checked = null) =>
      db.query(
        `insert into events (provider, provider_key, category, subject_id, kind, starts_at,
                             time_known, precision, state, name, digital_checked_at)
         values ('tmdb', $1, 'film', $2, 'release',
                 now() - ($3 * interval '1 month'), false, 'day', 'out', $1, $4)`,
        [key, subjectId, monthsAgo, checked],
      );

    await ev('tmdb:release:recent', 1);
    await ev('tmdb:release:older', 5);
    await ev('tmdb:release:ancient', 40);
    await ev('tmdb:release:upcoming', -2);
    // Six months out, and the row a plain `starts_at desc` would have asked
    // about first, every pass, forever.
    await ev('tmdb:release:faroff', -6);
    await ev('tmdb:release:justasked', 1, new Date().toISOString());
    // Two months back rather than one, so the ordering assertions below have an
    // unambiguous most-recent row to name.
    await ev('tmdb:release:askedages', 2, new Date(Date.now() - 40 * 86_400_000).toISOString());
    // The output of the pass, which must never become its input.
    await ev('tmdb:digital:recent', 1);
    await ev('tmdb:stream:recent', 1);
  });

  const due = async (staleDays = 10) =>
    (
      await db.query(
        `select provider_key from events
         where provider = 'tmdb' and kind = 'release'
           and provider_key like 'tmdb:release:%'
           and starts_at > now() - interval '9 months'
           and (digital_checked_at is null
                or digital_checked_at < now() - make_interval(days => $1))
         order by
           case when starts_at <= now() then 0 else 1 end,
           case when starts_at <= now() then starts_at end desc nulls last,
           starts_at`,
        [staleDays],
      )
    ).rows.map((r) => r.provider_key);

  test('a film that came out last month, never asked about', async () => {
    expect(await due()).toContain('tmdb:release:recent');
  });

  /* Where the answer is still capable of changing, and cheap: a film going
     straight to a service has a digital date before it has a cinema one. */
  test('and one that has not come out yet', async () => {
    expect(await due()).toContain('tmdb:release:upcoming');
  });

  /* Settled years ago. Re-asking spends a request to be told what we know. */
  test('but not one from three years ago', async () => {
    expect(await due()).not.toContain('tmdb:release:ancient');
  });

  test('not one asked about this morning', async () => {
    expect(await due()).not.toContain('tmdb:release:justasked');
  });

  /* The re-check that makes a late announcement arrive at all. */
  test('but yes to one asked about a month ago', async () => {
    expect(await due()).toContain('tmdb:release:askedages');
  });

  test('never the rows the pass itself writes', async () => {
    const keys = await due();
    expect(keys).not.toContain('tmdb:digital:recent');
    expect(keys).not.toContain('tmdb:stream:recent');
  });

  /*
   * The budget goes where the answers are.
   *
   * A digital date is announced in the weeks after a film opens: 15 in 20 films
   * released three months ago have one, against 1 in 20 still to come. So the
   * films that have already come out are asked first, most recent first.
   */
  test('a film that has come out is asked before one that has not', async () => {
    const keys = await due();
    expect(keys.indexOf('tmdb:release:recent')).toBeLessThan(keys.indexOf('tmdb:release:upcoming'));
    expect(keys[0]).toBe('tmdb:release:recent');
  });

  test('and the more recently it came out, the sooner it is asked', async () => {
    const keys = await due();
    expect(keys.indexOf('tmdb:release:recent')).toBeLessThan(keys.indexOf('tmdb:release:older'));
  });

  /*
   * The bug this ordering replaced. The window has no upper bound, so a plain
   * `starts_at desc` reads as "newest first" and actually starts at the
   * furthest-future row -- a sequel dated six months out, asked first on every
   * pass to be told it has no digital date, while the films that do have one
   * wait behind six months of forward calendar.
   */
  test('and a film half a year away is asked last, not first', async () => {
    const keys = await due();
    expect(keys[0]).not.toBe('tmdb:release:faroff');
    expect(keys[keys.length - 1]).toBe('tmdb:release:faroff');
  });

  test('genres copy from the film to its streaming row', async () => {
    const [g] = (
      await db.query(
        `insert into genres (provider, provider_key, category, slug, name)
         values ('tmdb','tmdb:genre:animation','film','animation-film','Animation') returning id`,
      )
    ).rows;
    const [from] = (
      await db.query(`select id from events where provider_key = 'tmdb:release:recent'`)
    ).rows;
    const [to] = (await db.query(`select id from events where provider_key = 'tmdb:stream:recent'`))
      .rows;
    await db.query(`insert into event_genres (event_id, genre_id) values ($1, $2)`, [
      from.id,
      g.id,
    ]);

    await db.query(
      `insert into event_genres (event_id, genre_id)
       select $1, genre_id from event_genres where event_id = $2
       on conflict (event_id, genre_id) do nothing`,
      [to.id, from.id],
    );

    const rows = (await db.query(`select genre_id from event_genres where event_id = $1`, [to.id]))
      .rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].genre_id).toBe(g.id);
  });
});

/* ------------------------------------------------------------------- page -- */

describe('how the film page says it', () => {
  const pages = readFileSync(
    new URL('../apps/web/src/views/pages.jsx', import.meta.url).pathname,
    'utf8',
  );
  const tmdb = readFileSync(
    new URL('../packages/catalog/src/tmdb.js', import.meta.url).pathname,
    'utf8',
  );

  test('the page can show both, under headings that differ', () => {
    expect(pages).toContain("label: 'Rent or buy'");
    expect(pages).toContain("label: 'Streaming'");
  });

  /* Otherwise the streaming row's own page prints its own date twice, under two
     headings, which reads as a bug rather than as an answer. */
  test('a date is not repeated on its own page', () => {
    const fn = pages.slice(pages.indexOf('function homeDates('));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body).toContain('!== own');
  });

  /*
   * The free half. release_dates is another section of a response the enrichment
   * pass already makes, so dropping it from the append would cost a request per
   * film to learn the same thing.
   */
  test('the dates ride along in the detail request rather than costing one', () => {
    expect(tmdb).toContain('watch/providers,release_dates');
  });
});
