/**
 * Internet Archive, as a second pair of hands.
 *
 * Kept because it fails differently from everything else here. Tidal has a
 * commercial catalogue with a commercial licensing story; the Archive has
 * freely-licensed recordings â€” live tapes, bootlegs, public-domain transfers,
 * classical and jazz sets â€” that Tidal will never hold. A listener asking for a
 * Grateful Dead soundboard or a 1970s radio session gets an answer from here and
 * a miss from the other source.
 *
 * It is also the source most likely to be reachable when the others are not,
 * being the least interesting target on the internet.
 *
 * The shape of the work is different, and that is the interesting part: the
 * Archive indexes *items*, not tracks. A search returns albums, and turning one
 * into playable rows means listing the files inside it. So a search here is a
 * search followed by a bounded fan-out, which is why `expand` is capped.
 */

import { STREAMINFO_BYTES, parseFlacStreamInfo, flacKbps } from '../flac.js';
import { httpJson, httpGet, TtlCache, settleAll, NotFound } from '../http.js';

const BASE = 'https://archive.org';

/** Search syntax that keeps the Archive to audio that already holds a FLAC. */
const QUERY =
  'mediatype:(audio) AND format:(Flac)';

/** How many items to consider, and how many of those to open. */
const ITEM_LIMIT = 12;
const EXPAND_LIMIT = 5;

/**
 * What this source is allowed to spend on one search.
 *
 * Not a preference. The Archive is the slow source — a search is one query plus
 * a bounded fan-out over item file listings, each of which is an independent
 * request to a host that is sometimes slow — and BitChord reads `/search` on the
 * path that decides whether a track starts. A source that answers in 2 s should
 * not be held for 16 s by one that answers in 16 s; the deadline is what stops
 * the second one from deciding the latency of the whole addon.
 *
 * Exceeding it is not a failure. Whatever rows were gathered in time are
 * returned, which is exactly the partial-answer behaviour `settleAll` exists for.
 */
const SEARCH_BUDGET_MS = 5_000;

/** Per-item, an Archive metadata call is cheap and the file list is small. */
const ITEM_TIMEOUT_MS = 5_000;

/** A file entry is only useful if it has a length and a size. */
const MIN_SECONDS = 20;
const MAX_SECONDS = 45 * 60;

const probeCache = new TtlCache(4_000);
const searchCache = new TtlCache(2_000);
const itemCache = new TtlCache(4_000);
const SEARCH_TTL_MS = 10 * 60 * 1000;
const ITEM_TTL_MS = 30 * 60 * 1000;

/**
 * A track number at the front of a filename: `03 - Title`, `3. Title`, `07_Title`.
 *
 * Album rippers are near-universal in their conventions and this is where most of
 * them agree, so stripping it materially improves the match BitChord attempts â€”
 * its matcher compares titles, and "07 - Ventura" is not "Ventura".
 */
const LEADING_TRACK_NUMBER = /^\s*\d{1,3}\s*[-._)\]]*\s+/;

/** Splits `Artist - Title` and other filename shapes back into their parts. */
function titleFromFilename(name) {
  let title = String(name ?? '')
    .replace(/\.flac$/i, '')
    .replace(/_/g, ' ')
    .replace(LEADING_TRACK_NUMBER, '')
    .trim();
  if (!title) title = String(name ?? '').replace(/\.flac$/i, '');
  return title;
}

function seconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 10) / 10;
}

/** A stable id for one file inside one item. */
function rowId(identifier, filename) {
  // `/` and `?` in an Archive filename are rare but not impossible, and a track
  // id becomes a path segment in `/stream/{id}`. base64url keeps the segment
  // intact whatever the name holds.
  return `archive:${identifier}:${Buffer.from(filename, 'utf8').toString('base64url')}`;
}

/** The inverse, tolerant of anything that is not one of our ids. */
export function parseArchiveId(id) {
  const raw = String(id ?? '');
  const rest = raw.startsWith('archive:') ? raw.slice('archive:'.length) : raw;
  const cut = rest.indexOf(':');
  if (cut < 1) return null;
  const identifier = rest.slice(0, cut);
  const encoded = rest.slice(cut + 1);
  try {
    return { identifier, filename: Buffer.from(encoded, 'base64url').toString('utf8') };
  } catch {
    return null;
  }
}

export const archive = {
  id: 'archive',
  label: 'Internet Archive',
  lossless: true,
  baseUrl: BASE,

  async search(query, limit = 20, signal) {
    const text = String(query ?? '').trim();
    if (!text) return [];

    // Keep the cache key to the query and the cap, not to the caller's limit:
    // this source always fans out a fixed number of items, so a larger limit is
    // the same work.
    const fanout = Math.min(Math.max(limit, 1), 40);
    return searchCache.wrap(`archive:${text.toLowerCase()}:${fanout}`, SEARCH_TTL_MS, async () => {
      // Composed with whatever deadline the caller brought, so a caller that
      // gives up early is not made to wait for this source regardless.
      const budget = AbortSignal.timeout(SEARCH_BUDGET_MS);
      const scoped = signal ? AbortSignal.any([budget, signal]) : budget;

      const params = new URLSearchParams({
        q: `${QUERY} AND (${text})`,
        rows: String(ITEM_LIMIT),
        page: '1',
        output: 'json',
        // Popularity is the only ranking signal the public API offers, and it
        // reliably puts a well-known recording above a noise upload for the
        // same title.
        'sort[]': 'downloads desc',
      });
      for (const field of ['identifier', 'title', 'creator']) params.append('fl[]', field);

      const payload = await httpJson(`${BASE}/advancedsearch.php?${params}`, {
        timeoutMs: 6_000,
        signal: scoped,
      });
      const docs = Array.isArray(payload?.response?.docs) ? payload.response.docs : [];
      const items = docs.slice(0, EXPAND_LIMIT);

      // Each item becomes rows only after its file list is read, so this is a
      // fan-out rather than a single mapping.
      const expanded = await settleAll(
        items.map((doc) => async () => ({ doc, rows: await this.expand(doc, scoped) })),
        items.length,
      );

      const rows = [];
      for (const entry of expanded) {
        if (!entry.ok) continue;
        rows.push(...entry.value.rows);
      }
      // The Archive's own ordering is popularity-then-title, and the fan-out
      // ran concurrently, so restore a stable order before truncating.
      return rows.slice(0, fanout);
    });
  },

  /**
   * One item's FLAC files, as rows.
   *
   * A miss here is ordinary: a large fraction of FLAC items hold one enormous
   * live set and a search for a studio album will land on several of them.
   */
  async expand(doc, signal) {
    const identifier = String(doc?.identifier ?? '');
    if (!identifier) return [];

    const metadata = await itemCache.wrap(`item:${identifier}`, ITEM_TTL_MS, async () => {
      const payload = await httpJson(`${BASE}/metadata/${encodeURIComponent(identifier)}`, {
        timeoutMs: ITEM_TIMEOUT_MS,
        retries: 0,
        signal,
      });
      return payload ?? {};
    });

    const files = Array.isArray(metadata?.files) ? metadata.files : [];
    if (!files.length) return [];

    const meta = metadata?.metadata ?? {};
    const album = String(doc?.title ?? meta.title ?? '').trim();
    // `creator` arrives as an array on many items and a bare string on others.
    const rawCreator = doc?.creator ?? meta.creator;
    const artist = (Array.isArray(rawCreator) ? rawCreator[0] : rawCreator) ?? '';

    const flacs = files.filter((file) => {
      const name = String(file?.name ?? '');
      if (!/\.flac$/i.test(name)) return false;
      // Derived artefacts: spectrograms and the Archive's own lossless
      // derivatives are files nobody meant to listen to.
      if (/^(__|spectrogram)/i.test(name)) return false;
      const length = seconds(file.length);
      return length !== null && length >= MIN_SECONDS && length <= MAX_SECONDS;
    });

    // Prefer the sidecar cover art, falling back to the item's own thumbnail.
    const artwork = files.find((f) => /^__ia_thumb\.jpg$/i.test(f.name ?? ''))
      ? `${BASE}/download/${encodeURIComponent(identifier)}/__ia_thumb.jpg`
      : undefined;

    return flacs.map((file) => {
      const name = String(file.name);
      const title = titleFromFilename(name);
      if (!title) return null;
      return {
        id: rowId(identifier, name),
        title,
        artist: String(artist).trim(),
        album,
        duration: seconds(file.length),
        artworkURL: artwork,
        format: 'flac',
        audioQuality: 'LOSSLESS',
        _source: this.id,
        _nativeId: name,
        _identifier: identifier,
      };
    }).filter(Boolean);
  },

  /**
   * The download URL for one file.
   *
   * `archive.org` will not serve spaces unencoded and will not serve a `?` or `#`
   * that the filename contains, so every segment is encoded individually.
   */
  mediaUrl(identifier, filename) {
    const dir = encodeURIComponent(String(identifier));
    const file = String(filename).split('/').map(encodeURIComponent).join('/');
    return `${BASE}/download/${dir}/${file}`;
  },

  async resolve(nativeId, tier, context = {}, signal) {
    // `context.identifier` arrives from the row id; a bare filename is resolved
    // against it. Without an identifier there is no file to serve.
    const identifier = context.identifier;
    if (!identifier) throw new NotFound('archive row carries no item identifier');
    const filename = String(nativeId ?? '');
    if (!filename) throw new NotFound('no filename');

    const url = this.mediaUrl(identifier, filename);
    const probe = await this.probe(url, `${identifier}/${filename}`, signal);

    return {
      url,
      codec: 'flac',
      container: 'flac',
      manifest: 'none',
      encrypted: false,
      sampleRate: probe?.sampleRate ?? null,
      bitDepth: probe?.bitDepth ?? null,
      bitrate: probe ? flacKbps(probe.byteLength, probe.durationSec) : null,
      channels: probe?.channels ?? null,
      probed: Boolean(probe),
      error: probe ? undefined : 'served, but the FLAC header could not be read',
    };
  },

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
      const contentRange = response.headers.get('content-range') ?? '';
      const slash = contentRange.lastIndexOf('/');
      const total = slash >= 0 ? Number(contentRange.slice(slash + 1)) : NaN;
      return {
        ...info,
        byteLength: Number.isFinite(total) && total > 0 ? total : null,
      };
    });
  },

  async health() {
    try {
      const payload = await httpJson(
        `${BASE}/advancedsearch.php?q=${encodeURIComponent(QUERY)}&rows=1&output=json`,
        { timeoutMs: 8_000, retries: 0 },
      );
      const n = Number(payload?.response?.numFound ?? 0);
      return { ok: true, detail: `${n.toLocaleString('en-US')} FLAC items indexed` };
    } catch (error) {
      return { ok: false, detail: error.message };
    }
  },
};
