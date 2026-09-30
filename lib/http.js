/**
 * The shared HTTP layer, and the things every source needs to get right.
 */

import { setTimeout as delay } from 'node:timers/promises';

/** Set when a source is unreachable or broken, so the server can degrade. */
export class UpstreamError extends Error {
  constructor(message, { status = 502, retryable = true } = {}) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
    this.retryable = retryable;
  }
}

/** The source answered, and does not have what was asked for. A miss, not a fault. */
export class NotFound extends Error {
  constructor(message = 'Not held by this source') {
    super(message);
    this.name = 'NotFound';
  }
}

/**
 * One GET against an upstream, with a hard ceiling.
 *
 * `fetch` in Node has no timeout of its own — a socket that never answers simply
 * hangs, and a hung search holds a BitChord source-resolution slot until the app
 * gives up. Every call this addon makes to somebody else's server therefore
 * carries a deadline, and `AbortSignal.timeout` is what enforces it.
 *
 * Retries are deliberately limited to the failures a second attempt can fix: a
 * dropped connection or a 429 that named a wait. A 404 is not retried because
 * the answer will not change, and a 4xx that is not a rate limit is not retried
 * because this addon is the thing asking wrong, not the thing being unlucky.
 *
 * @param {string} url
 * @param {{timeoutMs?: number, retries?: number, headers?: object,
 *          method?: string, range?: string, signal?: AbortSignal}} [opts]
 */
export async function httpGet(url, opts = {}) {
  const {
    timeoutMs = 12_000,
    retries = 2,
    headers = {},
    method = 'GET',
    range,
    signal,
  } = opts;

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      // Exponential, capped: enough to ride out a one-second blip without
      // turning one dead source into a minute of waiting.
      const wait = Math.min(400 * 2 ** (attempt - 1), 4_000);
      if (lastError?.retryAfterMs) await delay(Math.min(lastError.retryAfterMs, 8_000));
      else await delay(wait);
    }

    const deadline = AbortSignal.timeout(timeoutMs);
    const composed = signal ? AbortSignal.any([deadline, signal]) : deadline;

    const requestHeaders = {
      // Some upstreams serve a placeholder to anything that does not look like
      // a browser, and some serve nothing at all. Naming one costs nothing.
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      Accept: '*/*',
      ...headers,
    };
    if (range) requestHeaders.Range = range;

    let response;
    try {
      response = await fetch(url, { method, headers: requestHeaders, signal: composed });
    } catch (error) {
      lastError = new UpstreamError(`network error: ${error.message}`, { retryable: true });
      continue;
    }

    if (response.ok) return response;

    if (response.status === 404) {
      throw new NotFound(`${url} returned 404`);
    }

    if (response.status === 429) {
      const stated = Number(response.headers.get('retry-after'));
      lastError = new UpstreamError('rate limited', { status: 429, retryable: true });
      lastError.retryAfterMs = Number.isFinite(stated) ? stated * 1000 : undefined;
      continue;
    }

    // 5xx is the far end having a bad moment and is worth one more go; 4xx is
    // this request being wrong and will stay wrong.
    const retryable = response.status >= 500;
    throw new UpstreamError(`${url} returned HTTP ${response.status}`, {
      status: response.status >= 500 ? 502 : response.status,
      retryable,
    });
  }

  throw lastError ?? new UpstreamError(`${url} did not answer`);
}

/** `httpGet` plus a JSON parse, with the body size capped. */
export async function httpJson(url, opts = {}) {
  const response = await httpGet(url, {
    ...opts,
    headers: { Accept: 'application/json, text/plain, */*', ...(opts.headers ?? {}) },
  });
  const text = await response.text();
  if (!text.trim()) {
    throw new UpstreamError(`${url} returned an empty body`, { retryable: false });
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    // A captive portal or an HTML error page is the usual cause, and both are
    // the source being wrong rather than us.
    throw new UpstreamError(`${url} did not return JSON: ${text.slice(0, 80)}`, {
      retryable: false,
    });
  }
}

/**
 * A TTL cache with a size bound.
 *
 * Two different things are cached here and they have opposite lifetimes. Track
 * metadata is close to immutable and is worth keeping for the life of the
 * process. Stream URLs are not: every catalogue in use here mints a fresh
 * signature per resolution, and a stale one is a track that fails to start. So
 * `ttlMs` is the answer to that per entry.
 */
export class TtlCache {
  #entries = new Map();
  #max;

  constructor(max = 5_000) {
    this.#max = max;
  }

  get(key) {
    const hit = this.#entries.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= Date.now()) {
      this.#entries.delete(key);
      return undefined;
    }
    // Refresh recency so the bound evicts the genuinely cold entries.
    this.#entries.delete(key);
    this.#entries.set(key, hit);
    return hit.value;
  }

  set(key, value, ttlMs) {
    if (this.#entries.size >= this.#max) {
      // Evict the coldest tenth in one pass; cheaper than a per-write prune and
      // this cache is an optimisation, never a correctness requirement.
      const drop = Math.ceil(this.#max * 0.1);
      let n = 0;
      for (const k of this.#entries.keys()) {
        this.#entries.delete(k);
        if (++n >= drop) break;
      }
    }
    this.#entries.set(key, { value, expiresAt: Date.now() + ttlMs });
    return value;
  }

  /**
   * Read-through.
   *
   * `cacheNull` exists for the callers whose failure is a *transient* answer
   * rather than a negative one. A FLAC probe that times out, a network blip, an
   * upstream having a bad minute — none of those are "this is not FLAC", and
   * caching one under the same key as a success means a track can be permanently
   * stripped of the sample rate and bit depth that would have identified it,
   * for the life of the process, off a single unlucky packet.
   *
   * So a null result is recomputed on the next ask unless the caller says
   * otherwise. That is the right default: these caches exist to avoid a request,
   * and re-making one on the rare occasion it failed is far cheaper than
   * answering wrongly for the rest of the run.
   */
  async wrap(key, ttlMs, produce, { cacheNull = false } = {}) {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    const value = await produce();
    if (value !== null && value !== undefined) {
      this.set(key, value, ttlMs);
    }
    return value;
  }

  get size() {
    return this.#entries.size;
  }
}

/**
 * Runs tasks with bounded concurrency, resolving every one of them.
 *
 * One slow or broken source must not be able to fail a search the other sources
 * could have answered, so nothing here rejects: each task yields either its
 * value or the error that became its value. The caller decides what a failure
 * means, which is what keeps a partially-answered search usable.
 */
export async function settleAll(tasks, limit = 6) {
  const results = new Array(tasks.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (cursor < tasks.length) {
      const index = cursor++;
      try {
        results[index] = { ok: true, value: await tasks[index]() };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  });

  await Promise.all(workers);
  return results;
}

/**
 * BitChord's quality vocabulary, as its own client normalises it.
 *
 * `AddonClient.settingsFor` sends the manifest's declared option list when one
 * is published and the closest option *by meaning* is chosen; with no list it
 * sends the native tier verbatim. Either way the value arriving here is one of
 * a handful of spellings, and `matchTier` in `AddonClient` recognises
 * "lossless", "flac", "hires", "max" and "best" as all meaning the same thing.
 */
export function parseTier(raw) {
  const value = String(raw ?? '').toLowerCase();
  if (!value) return 'LOSSLESS';
  if (/lossless|flac|hi-?res|hires|max|best|24bit/.test(value)) return 'LOSSLESS';
  if (/low|96|128|min|small/.test(value)) return 'LOW';
  if (/high|320|normal|standard|medium/.test(value)) return 'HIGH';
  // Unrecognised: lossless is the only tier this addon can honestly serve.
  return 'LOSSLESS';
}

/** True when the tier asks for lossless, which is what every source here serves. */
export function wantsLossless(tier) {
  return tier === 'LOSSLESS';
}

/** Strips characters that would break a URL path segment. */
export function cleanSegment(value) {
  return String(value ?? '')
    .replace(/[ -]/g, '')
    .trim()
    .slice(0, 400);
}
