/**
 * Tidal, through Monochrome's public catalogue API.
 *
 * This is the source that makes the addon worth deploying. It needs no account,
 * no token and no developer credentials â€” `tracks.monochrome.st` is a public
 * read-only index, and the audio it serves is genuine FLAC.
 *
 * Two shapes, and the difference matters:
 *
 *   GET /search/tracks?q=â€¦&limit=N  â†’ metadata, JSON, fast
 *   GET /track/{id}                 â†’ the FLAC bytes themselves
 *
 * So there is no URL-resolution step. There is no signature to obtain, nothing
 * that expires between the `/search` and the `/stream` call, and no second
 * round trip on the path that has to finish before audio starts â€” which is the
 * one thing the other candidate sources all got wrong.
 *
 * What it does not do is describe itself. The response is
 * `application/octet-stream` with no extension and nothing about the audio
 * inside, so `probe.js` reads the FLAC header to answer for it.
 */

import { STREAMINFO_BYTES, parseFlacStreamInfo, flacKbps } from '../flac.js';
import { httpJson, httpGet, TtlCache, NotFound } from '../http.js';

const BASE = process.env.TIDAL_BASE_URL || 'https://tracks.monochrome.st';

/**
 * STREAMINFO cannot change for a given recording, and the `/track/{id}` URL is
 * stable, so this is cached for the life of the process rather than on a TTL.
 * A restart is the only thing that re-reads it.
 */
const probeCache = new TtlCache(4_000);

/** Search rows change; keep them briefly so a queue re-ask is free. */
const searchCache = new TtlCache(2_000);
const SEARCH_TTL_MS = 5 * 60 * 1000;

/**
 * Monochrome publishes artwork through its own proxy, which needs the Referer
 * its own page sends. Returning the URL unmodified would give BitChord a 403
 * and an empty album art square.
 */
function artwork(url) {
  if (!url) return undefined;
  return String(url).startsWith('http') ? String(url) : undefined;
}

/**
 * Tidal reports duration in milliseconds. BitChord reads `duration` as seconds
 * and accepts a decimal, so the division is not optional â€” handing it 391376
 * would put every track's length out by a factor of a thousand and quietly
 * break matching against anything that knows the real runtime.
 */
function seconds(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return Math.round(value / 100) / 10;
}

export const tidal = {
  id: 'tidal',
  label: 'Tidal',
  /** Advertised so `/health` can say what is wired up, not as a BitChord concept. */
  lossless: true,
  baseUrl: BASE,

  /**
   * @param {string} query
   * @param {number} limit
   * @returns {Promise<Array>} rows in BitChord's `tracks` shape
   */
  async search(query, limit = 20, signal) {
    const text = String(query ?? '').trim();
    if (!text) return [];

    return searchCache.wrap(`tidal:${text.toLowerCase()}:${limit}`, SEARCH_TTL_MS, async () => {
      const url =
        `${BASE}/search/tracks?q=${encodeURIComponent(text)}` +
        `&limit=${Math.min(Math.max(limit, 1), 50)}`;

      const payload = await httpJson(url, { timeoutMs: 12_000, signal });
      const tracks = Array.isArray(payload?.tracks) ? payload.tracks : [];

      return tracks
        // `playable: false` is Monochrome's own statement that the catalogue has
        // the metadata but no stream behind it. Handing those to BitChord spends
        // a `/stream` round trip to learn nothing.
        .filter((t) => t && t.playable !== false)
        .map((t) => ({
          id: `tidal:${t.id}`,
          title: String(t.title ?? '').trim(),
          artist: Array.isArray(t.artistNames) ? t.artistNames.join(', ') : String(t.artistNames ?? ''),
          album: '',
          duration: seconds(t.duration),
          artworkURL: artwork(t.artwork),
          format: 'flac',
          audioQuality: 'LOSSLESS',
          // Monochrome's index does not say which release a row came from, and
          // BitChord's matcher treats a missing album as "unknown" rather than
          // "wrong" â€” which is the correct thing for it to treat it as.
          albumArtworkURL: undefined,
          _source: this.id,
          _nativeId: String(t.id),
          _isrc: t.isrc,
        }))
        .filter((row) => row.title.length > 0);
    });
  },

  /**
   * Resolves one track to a FLAC URL plus what is genuinely known about it.
   *
   * @param {string} nativeId
   * @param {string} tier BitChord's normalised tier
   */
  async resolve(nativeId, tier, signal) {
    const id = String(nativeId ?? '').trim();
    if (!id) throw new NotFound('no track id');

    // Asking for the tier costs nothing and is what the catalogue expects; the
    // probe below reports what actually arrived regardless of what was asked
    // for, which is the whole point of it.
    const quality = tier === 'LOSSLESS' ? 'LOSSLESS' : tier;
    const url = `${BASE}/track/${encodeURIComponent(id)}` +
      (quality ? `?quality=${encodeURIComponent(quality)}` : '');

    const probe = await this.probe(url, id, signal);

    return {
      url,
      codec: 'flac',
      container: 'flac',
      manifest: 'none',
      encrypted: false,
      // Only ever filled in when the header was actually read. A field guessed
      // at is worse than the field absent, which BitChord reads as "unknown"
      // and this addon has no reason to misstate.
      sampleRate: probe?.sampleRate ?? null,
      bitDepth: probe?.bitDepth ?? null,
      bitrate: probe ? flacKbps(probe.byteLength, probe.durationSec) : null,
      channels: probe?.channels ?? null,
      probed: Boolean(probe),
      error: probe ? undefined : 'served, but the FLAC header could not be read',
    };
  },

  /**
   * Reads the first bytes of the media URL and parses STREAMINFO.
   *
   * Deliberately cheap and deliberately once: a range request for 42 bytes
   * against a file this addon does not read a byte of otherwise. Everything it
   * learns is a property of the file, so the result is held for the process.
   *
   * Returns null when the bytes are not FLAC, which is the signal that this URL
   * must not be labelled lossless.
   */
  async probe(url, cacheKey, signal) {
    return probeCache.wrap(`probe:${cacheKey}`, Number.MAX_SAFE_INTEGER, async () => {
      let response;
      try {
        response = await httpGet(url, {
          timeoutMs: 12_000,
          retries: 1,
          range: `bytes=0-${STREAMINFO_BYTES - 1}`,
          signal,
        });
      } catch {
        return null;
      }

      const head = Buffer.from(await response.arrayBuffer());
      const info = parseFlacStreamInfo(head);
      if (!info) return null;

      // `Content-Range: bytes 0-41/43704112` is the only place the byte count is
      // published. Without it the bitrate is genuinely unknown rather than
      // merely unstated, and is left absent.
      const contentRange = response.headers.get('content-range') ?? '';
      const slash = contentRange.lastIndexOf('/');
      const total = slash >= 0 ? Number(contentRange.slice(slash + 1)) : NaN;

      return {
        ...info,
        byteLength: Number.isFinite(total) && total > 0 ? total : null,
      };
    });
  },

  /**
   * The media URL, for the optional proxy route.
   *
   * Quality is dropped deliberately: a proxied request is already the tail of
   * playback, and appending a parameter the upstream ignores only invites a
   * cache miss on every seek.
   */
  mediaUrl(nativeId) {
    return `${BASE}/track/${encodeURIComponent(String(nativeId))}`;
  },

  /** For the health route. */
  async health() {
    try {
      const payload = await httpJson(`${BASE}/search/tracks?q=music&limit=1`, {
        timeoutMs: 8_000,
        retries: 0,
      });
      const n = Array.isArray(payload?.tracks) ? payload.tracks.length : 0;
      return { ok: true, detail: `${n} result(s) for a probe query` };
    } catch (error) {
      return { ok: false, detail: error.message };
    }
  },
};
