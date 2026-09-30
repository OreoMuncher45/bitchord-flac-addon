/**
 * A BitChord addon server for true FLAC.
 *
 * BitChord's addon protocol is three GET routes returning JSON, and that is the
 * whole of what this process implements. No code is downloaded by the app and
 * none is executed there; it asks this server what it holds, and plays the URL
 * this server names.
 *
 *   GET /manifest.json        what this addon is and what it can do
 *   GET /search               the catalogue, for one query
 *   GET /stream/{id}          one playable rendition of one track
 *   GET /media/{id}.flac      optional; see PROXY below
 *   GET /health               for humans, not for BitChord
 *
 * Design decisions worth stating, because each is a place where the obvious
 * choice is wrong:
 *
 * **A source that fails must not fail the search.** `settleAll` collects errors
 * rather than propagating them, because a listener asking for a track that only
 * one catalogue holds is owed an answer from the other. A partially-answered
 * search is useful; a 502 is not.
 *
 * **Quality claims are read, not asserted.** Every stream response is preceded
 * by a range request for 42 bytes and a parse of the FLAC header, so the
 * `sampleRate` and `bitDepth` reported are the file's own. BitChord grades a
 * source against what the device decodes, and a source that overstates what it
 * serves spends a track finding out. Where the header could not be read, the
 * fields are absent rather than filled with a plausible number.
 *
 * **The audio is not proxied by default.** BitChord opens the returned URL
 * directly, which keeps a 40 MB FLAC off this process entirely — no bandwidth,
 * no buffering, no second place for a connection to fail. That is the right
 * default for a phone on a metered plan. Set `PROXY=1` to serve the audio
 * through here instead, which buys a real `.flac` path and an `audio/flac`
 * content type at the cost of moving every byte through this host; it is worth
 * doing on a trusted LAN or when an upstream's content type is being
 * misread somewhere.
 *
 * Environment:
 *   PORT           listen port                        (default 8787)
 *   HOST           bind address                       (default 0.0.0.0)
 *   SOURCES        comma-separated source list        (default tidal,archive)
 *   PROXY          '1' to serve audio through here    (default 0)
 *   ADDON_TOKEN    if set, required as ?token= on
 *                  every route — for a LAN deployment
 */

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { settleAll, parseTier, NotFound, UpstreamError } from './lib/http.js';
import { makeTrackId, parseTrackId } from './lib/trackid.js';
import { STREAMINFO_BYTES } from './lib/flac.js';
import { tidal } from './lib/sources/tidal.js';
import { archive, parseArchiveId } from './lib/sources/archive.js';

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '0.0.0.0';
const PROXY_AUDIO = process.env.PROXY === '1';
const TOKEN = process.env.ADDON_TOKEN ?? '';
const MAX_ROWS = 40;
const SEARCH_TIMEOUT_MS = 15_000;

/**
 * Attempts on the media proxy, past the first.
 *
 * The CDN in front of the Tidal index returns 520 intermittently. That is
 * Cloudflare's way of saying an origin did not answer in time, and it is
 * transient — a player seeing it would just have a track that does not start.
 */
const MEDIA_RETRIES = 3;

const VERSION = '1.0.0';
const STARTED = Date.now();

/** Only the sources named here are asked. Order is the order they are asked in. */
const REGISTRY = new Map([
  [tidal.id, tidal],
  [archive.id, archive],
]);

const ACTIVE = (process.env.SOURCES ?? 'tidal,archive')
  .split(',')
  .map((name) => name.trim().toLowerCase())
  .filter((name) => REGISTRY.has(name))
  .map((name) => REGISTRY.get(name));

if (!ACTIVE.length) {
  console.error('[addon] SOURCES named no known source. Known:', [...REGISTRY.keys()].join(', '));
  process.exit(1);
}

// ── Small helpers ──────────────────────────────────────────────────────────

function json(res, status, value, extraHeaders = {}) {
  const body = JSON.stringify(value, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    // BitChord re-reads the manifest on its sources screen and caches
    // catalogue answers for ten minutes; nothing here should be cached longer
    // than that by an intermediary sitting in between.
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

function notFound(res, message) {
  // A 404 here is the protocol's way of saying "not in this addon", which tells
  // BitChord to move on to the next source rather than to treat the source as
  // broken. It is a success signal, not an error, and it must not be confused
  // with one.
  json(res, 404, { error: 'NOT_FOUND', message });
}

async function readBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    // A stream is never larger than a few megabytes; anything past this is not
    // audio and refusing it is cheaper than buffering it.
    if (total > 512 * 1024) throw new Error('body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function log(level, message, fields = {}) {
  const line = { ts: new Date().toISOString(), level, msg: message, ...fields };
  console.log(JSON.stringify(line));
}

// ── Token gate ─────────────────────────────────────────────────────────────

/**
 * Constant-time-ish comparison.
 *
 * A token on this server guards a listener's bandwidth, not a secret worth a
 * timing attack, but comparing with `===` on a string that arrives over the
 * network is a habit worth not having.
 */
function tokenOk(provided) {
  if (!TOKEN) return true;
  if (typeof provided !== 'string' || provided.length !== TOKEN.length) return false;
  let diff = 0;
  for (let i = 0; i < TOKEN.length; i++) diff |= provided.charCodeAt(i) ^ TOKEN.charCodeAt(i);
  return diff === 0;
}

// ── Manifest ───────────────────────────────────────────────────────────────

/**
 * The manifest.
 *
 * `resources` declares both endpoints this addon implements, and `search` is
 * what BitChord checks for: an addon that cannot be searched is refused
 * outright, because every lookup it is ever asked for starts with one.
 *
 * The `quality` setting is the part that is not obvious. BitChord does not
 * render a settings form — it reads the declared *defaults* and forwards them
 * as query parameters, then overrides `quality` with whatever tier it is
 * actually asking for, matched against this option list by meaning. Publishing
 * it means a lossless request arrives as `quality=lossless` rather than as the
 * native `LOSSLESS`, which is the spelling the upstream catalogues read best.
 */
const MANIFEST = {
  id: 'dev.oreomuncher45.bitchord.flac',
  /**
   * The name BitChord shows, and the reason this is not a constant.
   *
   * `SourceRegistry.identify` copies this into the stored config's label, and
   * `SourceConfig.displayName` reads `label.ifBlank { host ?: kind.label }`. A
   * blank name therefore does not fail — it *degrades*, and the row in the
   * sources list ends up labelled with the server's hostname, which is the one
   * outcome that reads as "something went wrong" to whoever added it.
   *
   * Naming the configured sources is also the honest thing: an addon claiming
   * "+ Internet Archive" while `SOURCES=tidal` was set would be describing a
   * catalogue it is not asking, and those two are configured differently for a
   * reason.
   */
  name: `FLAC Source · ${ACTIVE.map((source) => source.label).join(' + ')}`,
  version: VERSION,
  resources: ['search', 'stream'],
  settings: [
    {
      key: 'quality',
      type: 'select',
      default: 'lossless',
      options: [
        { label: 'Lossless (FLAC)', value: 'lossless' },
        { label: 'High', value: 'high' },
        { label: 'Low', value: 'low' },
      ],
    },
  ],
};

// ── Search ─────────────────────────────────────────────────────────────────

/**
 * One search across every active source.
 *
 * A query that one source answers and another does not is the normal case, not
 * an error, and the rows from both are returned in the order the sources were
 * configured — the first source's best match leading, because it is the one the
 * operator put first.
 */
async function search(query, limit, signal) {
  const results = await settleAll(
    ACTIVE.map(
      (source) => async () => ({ source, rows: await source.search(query, limit, signal) }),
    ),
    ACTIVE.length,
  );

  const rows = [];
  const failures = [];
  for (const entry of results) {
    if (entry.ok) {
      rows.push(...entry.value.rows);
    } else {
      failures.push({ source: entry.value?.source?.id ?? '?', error: entry.error?.message });
    }
  }

  // De-duplicate on the id, keeping the earliest occurrence. Two catalogues will
  // occasionally hand back the same recording, and BitChord's matcher would
  // otherwise spend two candidate slots on it.
  const seen = new Set();
  const unique = rows.filter((row) => {
    if (seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  });

  return { rows: unique.slice(0, limit), failures };
}

/**
 * Reduces a row to the wire shape BitChord reads.
 *
 * Only fields from `AddonTrack` are emitted. Everything prefixed `_` is this
 * addon's own bookkeeping — the source name and native handle it needs to
 * resolve the row later — and BitChord's parser ignores unknown keys, so sending
 * it is harmless but sending nothing it cannot use is better.
 */
function wireRow(row) {
  return {
    id: row.id,
    title: row.title,
    artist: row.artist ?? '',
    album: row.album ?? '',
    // Seconds, and a float. BitChord reads `duration` as a double so that an
    // upstream sending `240.0` is not a parse failure.
    duration: row.duration ?? undefined,
    artworkURL: row.artworkURL ?? undefined,
    albumArtworkURL: row.albumArtworkURL ?? undefined,
    format: row.format ?? 'flac',
    audioQuality: row.audioQuality ?? 'LOSSLESS',
  };
}

// ── Stream ─────────────────────────────────────────────────────────────────

/**
 * Resolves one row id to something playable.
 *
 * The Archive encodes two things in a row id — the item and the file inside it —
 * because a filename alone does not identify a file. That is recovered here
 * rather than in the source, so the source's own interface stays one handle in,
 * one handle out.
 */
async function resolve(id, tier, signal) {
  const parsed = parseTrackId(id);
  if (!parsed) throw new NotFound('not an id this addon issued');

  const source = REGISTRY.get(parsed.source);
  if (!source) throw new NotFound(`unknown source "${parsed.source}"`);

  if (source === archive) {
    const parts = parseArchiveId(id);
    if (!parts) throw new NotFound('malformed archive id');
    return { source: source.id, result: await source.resolve(parts.filename, tier, parts, signal) };
  }
  return { source: source.id, result: await source.resolve(parsed.nativeId, tier, signal) };
}

// ── Routes ─────────────────────────────────────────────────────────────────

async function handleSearch(req, res, url) {
  const query = (url.searchParams.get('q') ?? '').trim();
  // A blank query is not a bad request, it is a question with no words in it, and
  // the protocol's answer to "no rows" is an empty array with a 200. Returning
  // 400 here would read as a broken addon rather than an empty catalogue.
  if (!query) return json(res, 200, { tracks: [] });

  const tier = parseTier(url.searchParams.get('quality'));
  const limit = Math.min(
    Math.max(Number(url.searchParams.get('limit')) || MAX_ROWS, 1),
    MAX_ROWS,
  );

  const started = Date.now();
  const deadline = AbortSignal.timeout(SEARCH_TIMEOUT_MS);

  let outcome;
  try {
    outcome = await search(query, limit, deadline);
  } catch (error) {
    log('error', 'search threw', { query, error: error.message });
    return json(res, 502, {
      error: 'UPSTREAM_UNAVAILABLE',
      message: 'every source failed',
    });
  }

  if (outcome.failures.length) {
    log('warn', 'partial search', {
      query,
      tier,
      failed: outcome.failures,
      rows: outcome.rows.length,
    });
  }

  log('info', 'search', {
    query,
    tier,
    rows: outcome.rows.length,
    ms: Date.now() - started,
  });

  // `tracks` is the only array BitChord reads. Zero rows is a successful
  // answer — "this addon does not hold it" — and must not be an error status.
  return json(res, 200, { tracks: outcome.rows.map(wireRow) });
}

/**
 * Reads one track id out of a request path.
 *
 * `URL.pathname` hands back the *encoded* path, so a row id of `tidal:123`
 * arrives as `tidal%3A123` and looking for the `:` in it finds nothing. The
 * segment is decoded here, once, and that decode is also what makes the
 * base64url encoding in `trackid.js` necessary rather than merely tidy: a `/`
 * inside a name survives the round trip as `%2F` on the wire and comes back out
 * as a real delimiter, which is why ids that could contain one are encoded
 * before they are ever put in a row.
 */
function idFromPath(pathname, prefix) {
  const raw = pathname.slice(prefix.length);
  try {
    return decodeURIComponent(raw);
  } catch {
    // A malformed escape is a client sending something this addon never issued.
    return raw;
  }
}

async function handleStream(req, res, url) {
  const id = idFromPath(url.pathname, '/stream/');
  if (!id) return notFound(res, 'no track id in path');

  const tier = parseTier(url.searchParams.get('quality'));
  const deadline = AbortSignal.timeout(SEARCH_TIMEOUT_MS);

  let resolved;
  try {
    resolved = await resolve(id, tier, deadline);
  } catch (error) {
    if (error instanceof NotFound) return notFound(res, error.message);
    if (error instanceof UpstreamError) {
      // 5xx from the far end is its bad minute; 4xx is this addon's URL being
      // wrong. The two are reported differently because one is worth retrying
      // on the next track and the other is not.
      log('warn', 'stream upstream failure', { id, status: error.status, error: error.message });
      return json(res, 502, {
        error: 'UPSTREAM_UNAVAILABLE',
        message: error.message,
      });
    }
    throw error;
  }

  const answer = resolved.result;
  const proxied = PROXY_AUDIO;
  // The token has to travel with the media URL when the audio is proxied. The
  // gate below protects every route including `/media`, and a URL handed to
  // BitChord here carries no query of its own — so without this, a
  // token-protected server in proxy mode would resolve a track perfectly and
  // then 401 on every audio request, which is the worst shape a failure can
  // take: the addon looks healthy and nothing plays.
  const url_ = proxied
    ? `${publicOrigin(req)}/media/${encodeURIComponent(id)}.flac` +
      (TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : '')
    : answer.url;

  log('info', 'stream', {
    id,
    tier,
    source: resolved.source,
    proxied,
    probed: answer.probed,
    sampleRate: answer.sampleRate,
    bitDepth: answer.bitDepth,
  });

  return json(res, 200, {
    url: url_,
    // `flac` in `codec` is read first of all by `AddonSource.formatOf`, and
    // `flac` is in `SELF_DESCRIBING_CONTAINERS`, so either one alone would
    // settle the codec. Both are sent because a host that reads only one is
    // exactly what the spec's "send them whenever you know them" asks for.
    codec: answer.codec,
    container: answer.container,
    // `none` is a positive statement that the URL is the file itself, not an
    // index of it. It matters: BitChord builds a progressive source from this
    // URL and a manifest handed to a progressive source fails as unreadable.
    manifest: answer.manifest,
    encrypted: answer.encrypted,
    sampleRate: answer.sampleRate ?? undefined,
    bitDepth: answer.bitDepth ?? undefined,
    bitrate: answer.bitrate ?? undefined,
    // Free text, and the one field BitChord will happily parse a rating out of.
    quality: describeQuality(answer),
  });
}

function describeQuality(answer) {
  if (answer.sampleRate && answer.bitDepth) {
    const hires = answer.sampleRate > 48000 || answer.bitDepth > 16;
    return `${hires ? 'Hi-Res' : 'Lossless'} FLAC · ${answer.bitDepth}-bit / ${
      (answer.sampleRate / 1000).toFixed(1).replace(/\.0$/, '')
    } kHz`;
  }
  return 'Lossless FLAC · bit depth read from the FLAC header';
}

/** The origin BitChord should come back to, for a proxied media URL. */
function publicOrigin(req) {
  const forwardedProto = req.headers['x-forwarded-proto'];
  const proto = (Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto)?.split(',')[0]
    || 'http';
  const forwardedHost = req.headers['x-forwarded-host'];
  const host = (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost)
    || req.headers.host
    || `localhost:${PORT}`;
  return `${proto}://${host}`;
}

/**
 * The proxy route.
 *
 * Exists for one reason: `tracks.monochrome.st` answers a FLAC as
 * `application/octet-stream` from a path with no extension. BitChord handles
 * that correctly — its progressive source hands the bytes to every extractor
 * and `FlacExtractor` identifies them from the `fLaC` signature — so this is
 * belt and braces, not a fix for a known failure. What it does buy is a URL
 * Media3 can infer from without sniffing, and a content type a downstream HTTP
 * cache can key on.
 *
 * Proxying also means *this process* is the one asserting `audio/flac`, and an
 * assertion that can be wrong is worse than none. Two things guard it:
 *
 * **A retry on 5xx.** The CDN in front of the Tidal index returns 520
 * intermittently — an origin that did not answer in time — which is transient
 * by definition and invisible to a player, which would just see a failed track.
 *
 * **A magic check before any byte is passed on.** Four bytes are read and
 * compared against `fLaC`. A body that is not FLAC is refused with a 502
 * instead of being served with an `audio/flac` header, because handing a player
 * an HTML error page labelled as audio is exactly the mislabelling this whole
 * project exists to avoid — and it is what a naive pass-through of an upstream
 * `Content-Type` would produce.
 *
 * The check only runs when the client's range starts at byte zero, since that is
 * the only range that contains the signature; a seek mid-file is passed straight
 * through, because refusing one would break scrubbing.
 */
async function handleMedia(req, res, url) {
  const id = idFromPath(url.pathname, '/media/').replace(/\.flac$/i, '');

  let resolved;
  try {
    resolved = await resolve(id, parseTier(url.searchParams.get('quality')));
  } catch (error) {
    if (error instanceof NotFound) return notFound(res, error.message);
    return json(res, 502, { error: 'UPSTREAM_UNAVAILABLE', message: error.message });
  }

  const rangeHeader = req.headers.range;
  const clientWantsStart =
    !rangeHeader || /^\s*bytes\s*=\s*0-/i.test(rangeHeader);

  let upstream = null;
  for (let attempt = 0; attempt <= MEDIA_RETRIES; attempt++) {
    if (attempt > 0) await delay(250 * attempt);
    try {
      const candidate = await fetch(resolved.result.url, {
        headers: {
          'User-Agent': 'BitChord-FLAC-Addon/1.0',
          ...(rangeHeader ? { Range: rangeHeader } : {}),
        },
      });
      if (candidate.ok) {
        upstream = candidate;
        break;
      }
      // An upstream that answered with a body but a failing status has not
      // answered; try the next attempt rather than passing its page along.
      candidate.body?.cancel?.().catch(() => {});
      if (candidate.status < 500) {
        return json(res, 502, {
          error: 'UPSTREAM_REJECTED',
          message: `the source answered HTTP ${candidate.status}`,
        });
      }
    } catch {
      /* fall through to the retry */
    }
  }

  if (!upstream) {
    return json(res, 502, {
      error: 'UPSTREAM_UNAVAILABLE',
      message: 'the source did not return the audio',
    });
  }

  const headers = {
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=300',
  };
  for (const name of ['content-length', 'content-range', 'etag', 'last-modified']) {
    const value = upstream.headers.get(name);
    if (value) headers[name] = value;
  }

  if (!upstream.body) {
    headers['Content-Length'] = '0';
    return res.writeHead(204, headers).end();
  }

  // Read the signature before committing to a content type. Splitting the reader
  // rather than buffering the whole body is what keeps this a streaming proxy.
  let first = Buffer.alloc(0);
  const reader = upstream.body.getReader();
  if (clientWantsStart) {
    // `read()` resolves to a result object; the bytes are its `value`, and an
    // empty stream gives an absent one.
    const chunk = await reader.read();
    first = chunk.value ? Buffer.from(chunk.value) : Buffer.alloc(0);
    if (first.subarray(0, 4).toString('ascii') !== 'fLaC') {
      reader.cancel().catch(() => {});
      return json(res, 502, {
        error: 'NOT_FLAC',
        message: 'the source served something that is not a FLAC file',
      });
    }
  }

  headers['Content-Type'] = 'audio/flac';
  // `content-length` is forwarded exactly as the upstream stated it.
  //
  // It is tempting to subtract the bytes read for the signature check, on the
  // reasoning that they were taken out of the stream. They were not: they are
  // written back out immediately below, before anything else. Subtracting them
  // declares a body shorter than the one sent, and the client stops reading
  // short a whole TCP connection — a transfer that looks fine until it is
  // twenty megabytes in, which is the worst place for it to look fine.
  res.writeHead(upstream.status, headers);

  try {
    if (first.length) res.write(first);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(value)) await new Promise((r) => res.once('drain', r));
    }
    res.end();
  } catch (error) {
    // A client that scrubbed away mid-transfer is ordinary, not an error worth
    // a status line; the socket is simply gone.
    log('info', 'media transfer ended early', { id, error: error.message });
    res.destroy();
  }
}

// ── The server ─────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  const requestId = randomUUID().slice(0, 8);
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const started = Date.now();

  res.setHeader('X-Request-Id', requestId);

  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Range',
        'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
      });
      return res.end();
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return json(res, 405, { error: 'METHOD_NOT_ALLOWED', message: 'every route is a GET' });
    }

    if (!tokenOk(url.searchParams.get('token')) && url.pathname !== '/health') {
      return json(res, 401, { error: 'UNAUTHORIZED', message: 'a ?token= is required' });
    }

    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (path === '/manifest.json' || path === '/manifest') {
      return json(res, 200, MANIFEST);
    }

    if (path === '/search') {
      return await handleSearch(req, res, url);
    }

    if (path.startsWith('/stream/')) {
      return await handleStream(req, res, url);
    }

    if (path.startsWith('/media/')) {
      return await handleMedia(req, res, url);
    }

    // Not part of the addon protocol, and deliberately answering 200 with a
    // real body rather than a 404: a BitChord user checking this URL in a
    // browser should learn why it is not a thing they should paste.
    //
    // `/health` is the one route exempt from the token gate, because the moment
    // it is most needed is exactly when nobody has the token to hand.
    if (path === '/' || path === '/health') {
      const sources = await Promise.all(
        ACTIVE.map(async (source) => ({
          id: source.id,
          label: source.label,
          ...(await source.health()),
        })),
      );
      return json(res, 200, {
        addon: MANIFEST.name,
        version: VERSION,
        protocol: 'bitchord-addon',
        routes: ['/manifest.json', '/search', '/stream/{id}'],
        optionalRoutes: PROXY_AUDIO ? ['/media/{id}.flac'] : ['/media/{id}.flac (PROXY=0)'],
        proxyAudio: PROXY_AUDIO,
        uptimeSec: Math.round((Date.now() - STARTED) / 1000),
        node: process.version,
        sources,
      });
    }

    return json(res, 404, {
      error: 'NOT_FOUND',
      message: 'see GET /health for the routes this addon serves',
    });
  } catch (error) {
    log('error', 'unhandled', { requestId, path: url.pathname, error: error.stack ?? error.message });
    if (!res.headersSent) {
      return json(res, 500, { error: 'INTERNAL', message: error.message, requestId });
    }
    res.destroy();
  } finally {
    if (!res.headersSent) return;
    log('info', 'request', {
      requestId,
      method: req.method,
      path: url.pathname,
      status: res.statusCode,
      ms: Date.now() - started,
    });
  }
});

server.headersTimeout = 20_000;
server.requestTimeout = 0; // a long proxied FLAC must not be cut off mid-stream

server.listen(PORT, HOST, () => {
  log('info', 'listening', {
    url: `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`,
    sources: ACTIVE.map((s) => s.id),
    proxyAudio: PROXY_AUDIO,
    tokenRequired: Boolean(TOKEN),
  });
  console.log('');
  console.log(`  Add to BitChord:  http://<this-host>:${PORT}/manifest.json`);
  console.log(`  Health check:     http://<this-host>:${PORT}/health`);
  console.log('');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log('info', 'shutting down', { signal });
    server.close(() => process.exit(0));
    // A proxied audio transfer can hold a socket open for the length of a
    // track; give it a moment, then go regardless.
    setTimeout(() => process.exit(0), 5_000).unref();
  });
}

export { server, MANIFEST, search, resolve, describeQuality };
