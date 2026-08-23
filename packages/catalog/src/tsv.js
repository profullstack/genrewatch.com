/**
 * Reading a very large TSV off the wire, a line at a time.
 *
 * IMDb publishes its catalogue as gzipped TSV: title.basics is about 185MB
 * compressed and nine hundred megabytes open, eleven and a half million rows. The
 * sibling project downloads these to disk and feeds them to `psql \copy`, which is
 * the right tool where you have a psql and a filesystem. Here there is neither:
 * the production database is internal to Railway with no public proxy, so the
 * import has to run inside the container that already holds a connection, and the
 * container has no room to land a gigabyte.
 *
 * So it streams. Nothing is written to disk, nothing larger than one line is held,
 * and the caller decides per row whether to keep anything -- which is what makes a
 * pass over eleven million rows cost a few hundred megabytes of transfer and
 * almost no memory.
 */

/**
 * Fetch a gzipped TSV and yield one parsed row at a time.
 *
 * The header row names the columns and every subsequent row is yielded as an
 * object keyed by those names, so a column moving in a future dump changes nothing
 * here. IMDb has moved columns before.
 *
 * `\N` is IMDb's null. It arrives as the two characters rather than as an empty
 * field, and treating it as a string is how a year of "\N" becomes NaN three
 * layers down.
 *
 * @param {string} url
 * @param {{signal?: AbortSignal}} [opts]
 * @returns {AsyncGenerator<Record<string,string|null>>}
 */
export async function* streamTsvGz(url, { signal } = {}) {
  const res = await fetch(url, {
    signal,
    headers: { 'user-agent': 'curl/8.5.0 (+https://genrewatch.com)' },
  });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  if (!res.body) throw new Error(`${url} sent no body`);

  const lines = res.body
    .pipeThrough(new DecompressionStream('gzip'))
    .pipeThrough(new TextDecoderStream());

  let header = null;
  /*
   * The tail of the last chunk, which is almost never a whole line.
   *
   * A decoded chunk ends wherever the network split it, so the final fragment has
   * to be carried into the next one. Yielding it as a row instead is the classic
   * version of this bug and it does not fail loudly -- it produces a stream of
   * rows that are each fine and occasionally truncated.
   */
  let rest = '';

  for await (const chunk of lines) {
    rest += chunk;
    let nl = rest.indexOf('\n');
    while (nl !== -1) {
      const line = rest.slice(0, nl);
      rest = rest.slice(nl + 1);
      nl = rest.indexOf('\n');

      if (line === '') continue;
      const cells = line.split('\t');
      if (!header) {
        header = cells;
        continue;
      }
      yield toRow(header, cells);
    }
  }

  // Whatever was left when the stream ended. A final line without a trailing
  // newline is legal and IMDb's dumps have had one.
  if (rest.trim() !== '' && header) yield toRow(header, rest.split('\t'));
}

function toRow(header, cells) {
  /** @type {Record<string,string|null>} */
  const row = {};
  for (let i = 0; i < header.length; i++) {
    const v = cells[i];
    row[header[i]] = v === undefined || v === '\\N' || v === '' ? null : v;
  }
  return row;
}

/** A TSV integer, or null. `\N` has already become null; this catches the rest. */
export function intOf(v) {
  if (v === null || v === undefined) return null;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}
