/**
 * Runs a BitChord module the way BitChord runs it, without a phone.
 *
 * The bridge is reproduced from QuickJsExecutor.kt rather than approximated,
 * because the point is to catch the things the real sandbox does that a plain
 * Node `fetch` does not:
 *
 *   - the module body is wrapped exactly as `newEngine` wraps it, so a missing
 *     or misspelled export is caught here rather than on a device;
 *   - `fetch` has no `arrayBuffer()`, so a module that reaches for one fails
 *     here too;
 *   - headers cross the bridge, which is what makes the FLAC Range check work;
 *   - the exports are awaited and `JSON.stringify`'d the way `callOn` does.
 *
 * Usage:  node scripts/test-module.js [path/to/module.js]
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const modulePath = resolve(process.argv[2] ?? `${here}/../modules/bitchord-stream-flac.js`);
const code = readFileSync(modulePath, 'utf8');

let pass = 0;
let fail = 0;
function check(label, ok, detail = '') {
  if (ok) { pass++; console.log(`  \x1b[32mPASS\x1b[0m  ${label}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`); }
  else { fail++; console.log(`  \x1b[31mFAIL\x1b[0m  ${label}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`); }
}

/**
 * BitChord's bridge `fetch`, reproduced.
 *
 * `headers.get()` returning null for everything is not a simplification — that
 * is literally what QuickJsExecutor installs, so a module that reads a response
 * header gets nothing and must not depend on one.
 */
/**
 * BitChord's bridge `fetch`, reproduced exactly.
 *
 * `headers.get()` returning null for everything is not a simplification — that
 * is literally what QuickJsExecutor installs.
 *
 * `json()` and `text()` are **synchronous** here, exactly as in QuickJsExecutor,
 * and that is the part worth stating loudly. A harness that "helpfully" returns
 * promises from them will pass a module that throws a TypeError on the first
 * track lookup inside BitChord. It did exactly that here: the module under test
 * called `resp.text().then(...)`, which is a TypeError against the real bridge,
 * and it was green against this file until this file started telling the truth.
 */
function bridgeFetch(url, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (!Object.keys(headers).some((k) => k.toLowerCase() === 'user-agent')) {
    headers['User-Agent'] =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
  }
  return fetch(url, { method: options.method ?? 'GET', headers, body: options.body }).then(
    async (resp) => {
      const body = await resp.text();
      return {
        ok: resp.ok,
        status: resp.status,
        statusText: resp.ok ? 'OK' : 'Error',
        json: () => JSON.parse(body),
        text: () => body,
        // Exactly what BitChord installs. A module that calls this throws.
        arrayBuffer: () => { throw new Error('Not implemented'); },
        clone() { return this; },
        headers: { get: () => null },
      };
    },
  );
}

/** The `setTimeout` BitChord installs: delays, then runs the callback. */
const bridgeSetTimeout = (fn, ms) => new Promise((done) => {
  setTimeout(() => { if (typeof fn === 'function') fn(); done(0); }, ms || 0);
});

/**
 * Loads the module through BitChord's exact wrapper, then returns its exports.
 *
 * Mirrors `newEngine`: a `module`/`exports`/`self` scope, and the two named
 * exports required for the app to accept it at all.
 */
function loadModule(source) {
  const module_ = { exports: {} };
  let initError = null;

  const wrapped = new Function(
    'module', 'exports', 'self', 'fetch', 'setTimeout', 'clearTimeout', 'console',
    `
    try {
      ${source}
    } catch (e) {
      __initError = e && e.message ? e.message : String(e);
    }
  `,
  );

  // `__initError` has to be reachable after the call, so it is threaded through
  // a sentinel the wrapper can see.
  let captured = null;
  const runner = new Function(
    'module', 'exports', 'self', 'fetch', 'setTimeout', 'clearTimeout', 'console', 'sink',
    `
    try {
      ${source}
    } catch (e) {
      sink.push(e && e.message ? e.message : String(e));
    }
  `,
  );

  runner(
    module_, module_.exports, {}, bridgeFetch, bridgeSetTimeout, () => {},
    { log() {}, error() {}, warn() {}, info() {} }, captured ?? (captured = []) ,
  );
  initError = captured && captured.length ? captured[0] : null;

  if (initError) throw new Error(`Module init error: ${initError}`);
  const exports_ = module_.exports;
  if (!exports_ || typeof exports_ !== 'object') throw new Error('module.exports was not set');
  return exports_;
}

console.log(`\x1b[1mBitChord module harness\x1b[0m  →  ${modulePath}\n`);

let mod;
try {
  mod = loadModule(code);
  check('loads without a syntax or init error', true);
} catch (error) {
  check('loads without a syntax or init error', false, error.message);
  process.exit(1);
}

// The condition `newEngine` uses to decide a module is usable at all.
check(
  'exports a function BitChord will call',
  typeof mod.searchTracks === 'function' || typeof mod.getTrackStreamUrl === 'function',
  `[${Object.keys(mod).join(', ')}]`,
);
check('exports searchTracks', typeof mod.searchTracks === 'function');
check('exports getTrackStreamUrl', typeof mod.getTrackStreamUrl === 'function');

// ── search ─────────────────────────────────────────────────────────────────
console.log('\n\x1b[1msearchTracks(query, limit, context)\x1b[0m');
const context = { settings: {} };
const searchResult = await mod.searchTracks('Daft Punk One More Time', 10, context);
check('resolves to an object', searchResult && typeof searchResult === 'object');
check('has a tracks array', Array.isArray(searchResult.tracks),
  `${searchResult.tracks?.length} rows`);
check('rows carry the fields the contract reads', (searchResult.tracks ?? []).every(
  (t) => typeof t.id === 'string' && t.id && typeof t.title === 'string' && t.title,
));
check('durations are in seconds, not milliseconds', (searchResult.tracks ?? []).every(
  (t) => t.duration === 0 || (t.duration > 0 && t.duration < 3600),
), `${searchResult.tracks?.[0]?.duration}s`);
check('rows are marked lossless and flac', (searchResult.tracks ?? []).every(
  (t) => t.audioQuality === 'LOSSLESS' && t.format === 'flac',
));
if (searchResult.tracks?.length) {
  console.log(`        \x1b[2m"${searchResult.tracks[0].title}" — ${searchResult.tracks[0].artist}`
    + ` [${searchResult.tracks[0].duration}s]\x1b[0m`);
}

// The two degenerate calls that must not throw.
check('a blank query returns an empty result, not an error',
  (await mod.searchTracks('', 10, context)).tracks.length === 0);
check('a null query returns an empty result, not an error',
  (await mod.searchTracks(null, 10, context)).tracks.length === 0);

// ── stream ─────────────────────────────────────────────────────────────────
console.log('\n\x1b[1mgetTrackStreamUrl(id, quality, context)\x1b[0m');
const row = searchResult.tracks?.[0];
if (!row) {
  console.log('  \x1b[33mskipped — search returned nothing\x1b[0m');
} else {
  const stream = await mod.getTrackStreamUrl(row.id, 'LOSSLESS', context);
  check('resolves to an object', stream && typeof stream === 'object');
  check('has a streamUrl', typeof stream.streamUrl === 'string' && stream.streamUrl.length > 0,
    String(stream.streamUrl).slice(0, 72));
  check('the URL is http(s), which ModuleSource.malformed requires',
    /^https?:\/\//i.test(stream.streamUrl ?? ''));
  check('marks the rendition lossless', stream.track?.audioQuality === 'LOSSLESS');
  check('does NOT invent a bit depth it cannot read',
    stream.track?.bitDepth === undefined || stream.track?.bitDepth === null,
    `bitDepth=${stream.track?.bitDepth}`);
  check('does NOT invent a sample rate it cannot read',
    stream.track?.sampleRate === undefined || stream.track?.sampleRate === null,
    `sampleRate=${stream.track?.sampleRate}`);

  // ── the check that matters ───────────────────────────────────────────────
  console.log('\n\x1b[1mDoes it only claim FLAC when it is FLAC?\x1b[0m');

  // Retried, and counted as a flaky-upstream skip rather than a failure. The CDN
  // in front of this catalogue returns 520 on roughly 1 request in 7 (measured:
  // 3 of 20), and a module that refuses a stream on a 520 is behaving correctly
  // — it is the upstream that failed, not the claim. A single sample would fail
  // this suite regularly for no reason, which is how a check stops being trusted.
  let magic = null;
  let attempts = 0;
  for (let i = 0; i < 6 && magic === null; i++) {
    attempts++;
    const head = await bridgeFetch(stream.streamUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: '*/*', Range: 'bytes=0-3' },
    });
    if (!head.ok) continue; // 520 from the CDN: no signal either way
    const body = String(await head.text());
    if (body.length > 8) { // Range ignored; whole file returned
      magic = body.substring(0, 4);
    } else {
      magic = body.substring(0, 4);
    }
  }
  check('the URL it returns really begins with fLaC', magic === 'fLaC',
    magic === null
      ? `no clean answer after ${attempts} tries (CDN flakiness)`
      : `magic=${JSON.stringify(magic)} after ${attempts} try/ies`);

  // A URL that is not FLAC must be refused, because BitChord reads a null
  // streamUrl as "this source does not have it" and moves to the next source.
  const bogus = await mod.getTrackStreamUrl('123|999999999999999999', 'LOSSLESS', context);
  check('refuses an id that is not a FLAC rather than claiming one is',
    !bogus.streamUrl, `streamUrl=${bogus.streamUrl}`);
}

console.log(`\n${'─'.repeat(60)}`);
console.log(fail === 0
  ? `\x1b[32m✓ ${pass}/${pass + fail} checks passed\x1b[0m\n`
  : `\x1b[31m✗ ${fail}/${pass + fail} failed\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
