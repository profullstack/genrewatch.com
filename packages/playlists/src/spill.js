import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Holding a provider's response somewhere that is not memory.
 *
 * The import has to see the whole body before it can decide what to do with any
 * of it: the provider supports no conditional request, so "has this changed"
 * cannot be answered until the last byte has been hashed. That used to mean the
 * parse ran first and its entries were held until the hash agreed they were
 * wanted -- which is why a size ceiling existed at all, and why raising it to fit
 * a 583MB catalogue would simply have moved the failure from a refusal to an
 * out-of-memory kill.
 *
 * A file on disk answers it instead. The body lands there while it is hashed,
 * and one of two things happens: the hash matches what we already stored and the
 * file is deleted unparsed, or it does not and the file is parsed straight into
 * Postgres in batches. Either way nothing whole is ever resident.
 *
 * The unchanged case is the common one -- most polls see a byte-identical file --
 * and it is now also the cheap one. It used to parse several million entries and
 * throw them away.
 */

/**
 * Stream a body to a temp file, handing every chunk to `onChunk` on the way past.
 *
 * `onChunk` is where hashing, counting and any size policy live: throwing from it
 * abandons the download, cancels the underlying stream and removes the file, so a
 * URL pointing at something enormous costs only what has arrived so far.
 *
 * The caller must call `discard()` -- on every path, including its own errors --
 * or the file outlives the process that made it.
 *
 * @param {AsyncIterable<Uint8Array>} body
 * @param {{ onChunk?: (chunk: Uint8Array) => void }} [opts]
 * @returns {Promise<{ path: string, discard: () => Promise<void> }>}
 */
export async function spillToDisk(body, { onChunk } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'playlist-'));
  const path = join(dir, 'list.m3u');
  const discard = () => rm(dir, { recursive: true, force: true });
  const out = createWriteStream(path);

  /*
   * One error listener for the life of the stream, attached before anything is
   * written.
   *
   * A write stream with no 'error' listener throws its failures at the process
   * instead of at us, and the interesting one arrives late: `createWriteStream`
   * opens lazily, so a write queued just before we give up can still fail after
   * we have stopped caring. Recording it here rather than reacting to it keeps
   * the error the CALLER threw as the one that propagates -- a size ceiling
   * should report the ceiling, not the ENOENT it caused.
   */
  let streamError = null;
  out.on('error', (err) => {
    streamError ??= err;
  });

  /** Resolves whenever the stream is finally closed, however that happens. */
  const closed = new Promise((resolve) => out.once('close', resolve));

  /**
   * Wait for room, without leaking a listener per wait.
   *
   * `once('error')` per drain is how this file first went wrong: a large list
   * waits hundreds of times, each wait left its listener behind, and Node warned
   * about the leak long before anything failed.
   */
  const drain = () =>
    new Promise((resolve, reject) => {
      const done = (err) => {
        out.off('drain', onDrain);
        out.off('error', onError);
        out.off('close', onClose);
        err ? reject(err) : resolve();
      };
      const onDrain = () => done(null);
      const onError = (err) => done(err);
      // Closed while we were waiting for room: nothing will drain now, and
      // waiting on 'drain' alone would hang the import forever.
      const onClose = () => done(streamError ?? new Error('the download could not be stored'));
      out.on('drain', onDrain);
      out.on('error', onError);
      out.on('close', onClose);
    });

  try {
    for await (const chunk of body) {
      onChunk?.(chunk);
      if (streamError) throw streamError;
      /*
       * Backpressure honoured, not ignored.
       *
       * A write stream buffers without limit when nobody waits for `drain`, so
       * skipping this would put the file in memory on its way to the disk and
       * lose the whole point of writing it down. Provider lines are usually
       * slower than the disk, so this rarely waits.
       */
      if (!out.write(chunk)) await drain();
    }
    await new Promise((resolve, reject) => {
      out.end((err) => (err ? reject(err) : resolve()));
    });
    if (streamError) throw streamError;
  } catch (err) {
    /*
     * Closed BEFORE the directory goes, not alongside it.
     *
     * Removing the directory out from under a stream that is still opening turns
     * a clean "that list is larger than we store" into an ENOENT from the
     * filesystem, which is both wrong and the one message this change exists to
     * stop people seeing. Waiting for 'close' means nothing is left to touch it.
     */
    out.destroy();
    await closed;
    await discard();
    throw err;
  }

  return { path, discard };
}

/**
 * Read a spilled file back as chunks, for a second pass over it.
 *
 * @param {string} path
 * @returns {AsyncIterable<Uint8Array>}
 */
export function readSpill(path) {
  return createReadStream(path);
}
