#!/usr/bin/env node
/**
 * Contract check.
 *
 * Runs a live addon against the rules BitChord actually enforces, rather than
 * against a description of them. Every assertion below is traceable to a
 * specific place in BitChord's own source, because the point of this file is
 * that a failure names the requirement it broke.
 *
 *   AddonClient.manifest      — a blank `id` is refused; `search` must be declared
 *   AddonSource.formatOf      — `codec` must be in AUDIO_CODECS
 *   AddonSource.openable      — `ModuleSource.malformed` must not reject the URL
 *   AddonStream.transport     — `manifest` decides DASH/HLS vs progressive
 *   AddonSource.fromRow       — a search row must carry a non-empty id and title
 *
 * And then the thing none of that covers: it downloads the first bytes of a real
 * stream and asserts they are `fLaC`. A source that passes every structural rule
 * while serving a 320 kbps MP3 under a LOSSLESS label is precisely the failure
 * this is here to catch.
 *
 * Usage:  node scripts/contract-check.js [baseUrl]
 */

import { STREAMINFO_BYTES, parseFlacStreamInfo, flacKbps } from '../lib/flac.js';

const BASE = (process.argv[2] ?? process.env.ADDON_URL ?? 'http://localhost:8787').replace(/\/+$/, '');
const UA = 'BitChord-FLAC-Addon-ContractCheck/1.0';

let passed = 0;
let failed = 0;
const failures = [];

function check(label, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  \x1b[32mPASS\x1b[0m  ${label}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`);
  } else {
    failed++;
    failures.push(label);
    console.log(`  \x1b[31mFAIL\x1b[0m  ${label}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`);
  }
}

function section(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

async function get(path, init = {}) {
  const response = await fetch(`${BASE}${path}`, {
    headers: { 'User-Agent': UA, ...(init.headers ?? {}) },
    ...init,
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not every route is JSON */
  }
  return { status: response.status, headers: response.headers, text, json };
}

/** `AddonStream.isEncrypted` as BitChord reads it. */
function isEncrypted(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === 'boolean') return value;
  const text = String(value).toLowerCase();
  return text !== 'false' && text !== 'none' && text.length > 0;
}

/** `AddonStream.transport` as BitChord normalises it. */
function transportOf(stream) {
  const stated = [stream.manifest, stream.mediaType, stream.format]
    .map((v) => (typeof v === 'string' && v.trim() ? v.trim() : null))
    .find(Boolean);
  if (!stated) return null;
  const v = stated.toLowerCase();
  if (['hls', 'm3u8', 'application/x-mpegurl', 'application/vnd.apple.mpegurl'].includes(v)) return 'hls';
  if (['dash', 'mpd', 'application/dash+xml'].includes(v)) return 'dash';
  return null;
}

async function main() {
  console.log(`\x1b[1mBitChord addon contract check\x1b[0m  →  ${BASE}`);

  // ── Manifest ────────────────────────────────────────────────────────────
  section('GET /manifest.json');
  const manifest = await get('/manifest.json');
  check('responds 200', manifest.status === 200, `status ${manifest.status}`);
  check('returns JSON', manifest.json !== null);

  const m = manifest.json ?? {};
  check('has a non-empty id', typeof m.id === 'string' && m.id.trim().length > 0,
    `id="${m.id}"`);
  check('declares a name', typeof m.name === 'string' && m.name.trim().length > 0,
    `name="${m.name}"`);
  check('declares search', (m.resources ?? []).some((r) => String(r).toLowerCase() === 'search'),
    `resources=[${(m.resources ?? []).join(', ')}]`);

  // ── The name the user will actually see ─────────────────────────────────
  // Reproduces BitChord's own resolution rather than trusting that it works:
  //   AddonManifest.displayName = name.ifBlank { id }
  //   SourceConfig.displayName  = label.ifBlank { host ?: kind.label }
  // A manifest with a blank `name` therefore does not error — it degrades, and
  // the row ends up labelled with the server's hostname, which is the one
  // outcome that reads as "something went wrong" to whoever added it. This
  // section exists so that failure is caught here rather than on a phone.
  section('The name BitChord will display in Sources');
  const displayName = (m.name ?? '').trim() || (m.id ?? '').trim();
  const host = new URL(BASE).host;
  check('resolves to a non-empty display name', Boolean(displayName),
    `displayName="${displayName}"`);
  check('comes from the manifest, not a fallback',
    Boolean((m.name ?? '').trim()),
    (m.name ?? '').trim() ? 'manifest supplies it' : 'would degrade to id/host');
  check('is not the hostname', !displayName.includes(host),
    `a blank name would show "${host}"`);
  check('fits a list row', displayName.length <= 48, `${displayName.length} chars`);
  console.log(`        \x1b[1msources screen will show: "${displayName}"\x1b[0m`);

  // ── Search ──────────────────────────────────────────────────────────────
  section('GET /search?q=…&quality=LOSSLESS');
  const query = process.env.CHECK_QUERY ?? 'Daft Punk One More Time';
  const search = await get(`/search?q=${encodeURIComponent(query)}&quality=LOSSLESS`);
  check('responds 200', search.status === 200, `status ${search.status}`);
  check('has a tracks array', Array.isArray(search.json?.tracks));

  const tracks = search.json?.tracks ?? [];
  check('returns at least one row', tracks.length > 0, `${tracks.length} rows for "${query}"`);
  check(
    'every row has a non-empty id and title',
    tracks.length > 0 && tracks.every((t) => t.id?.trim() && t.title?.trim()),
  );
  check(
    'every id is safe as one path segment',
    tracks.every((t) => !/[?#\s]/.test(String(t.id))),
  );
  check(
    'durations, where present, are in seconds and plausible',
    tracks
      .filter((t) => t.duration != null)
      .every((t) => t.duration > 0 && t.duration < 60 * 60),
  );

  if (tracks.length) {
    console.log(`        first: "${tracks[0].title}" — ${tracks[0].artist} ` +
      `[${tracks[0].duration ?? '?'}s] id=${tracks[0].id}`);
  }

  // ── Empty query ─────────────────────────────────────────────────────────
  section('GET /search with a blank query');
  const blank = await get('/search?q=&quality=LOSSLESS');
  check('responds without erroring', blank.status === 200, `status ${blank.status}`);
  check('returns no rows', (blank.json?.tracks ?? []).length === 0);

  // ── Stream ──────────────────────────────────────────────────────────────
  if (!tracks.length) {
    section('GET /stream — skipped, no rows to resolve');
  } else {
    const target = tracks[0];
    section(`GET /stream/${target.id}?quality=LOSSLESS`);
    const stream = await get(
      `/stream/${encodeURIComponent(target.id)}?quality=LOSSLESS&atmos=auto`,
    );
    check('responds 200', stream.status === 200, `status ${stream.status}`);

    const s = stream.json ?? {};
    check('has a url', typeof s.url === 'string' && s.url.length > 0, s.url?.slice(0, 90));
    check(
      'url is absolute https',
      typeof s.url === 'string' && /^https:\/\//i.test(s.url),
    );
    check(
      'codec is one BitChord recognises',
      ['flac', 'alac', 'wav', 'aiff', 'mp3', 'aac', 'he-aac', 'm4a', 'mp4',
        'ogg', 'opus', 'vorbis', 'webm', 'eac3-joc', 'ec3-joc'].includes(String(s.codec).toLowerCase()),
      `codec="${s.codec}"`,
    );
    check('is not encrypted', !isEncrypted(s.encrypted), `encrypted=${JSON.stringify(s.encrypted)}`);
    check(
      'does not declare a manifest transport for progressive audio',
      transportOf(s) === null,
      `manifest="${s.manifest}"`,
    );
    check(
      'states a sample rate, or admits it does not know',
      s.sampleRate == null || (Number(s.sampleRate) > 0 && Number(s.sampleRate) < 1_000_000),
      `sampleRate=${s.sampleRate}`,
    );
    check(
      'states a bit depth inside the FLAC range',
      s.bitDepth == null || (Number(s.bitDepth) >= 8 && Number(s.bitDepth) <= 32),
      `bitDepth=${s.bitDepth}`,
    );

    // ── The claim that matters: is it actually FLAC? ──────────────────────
    section('The audio itself — does the label match the bytes?');
    let probed = null;
    try {
      const response = await fetch(s.url, {
        headers: { 'User-Agent': UA, Range: `bytes=0-${STREAMINFO_BYTES - 1}` },
      });
      const head = Buffer.from(await response.arrayBuffer());
      check('media URL is fetchable', response.ok, `status ${response.status}`);
      check(
        'supports range requests (BitChord seeks)',
        response.status === 206 || /bytes/i.test(response.headers.get('accept-ranges') ?? ''),
        `Accept-Ranges=${response.headers.get('Accept-Ranges')}`,
      );
      check('bytes begin with fLaC', head.subarray(0, 4).toString('ascii') === 'fLaC',
        `magic=${JSON.stringify(head.subarray(0, 4).toString('latin1'))}`);

      probed = parseFlacStreamInfo(head);
      check('STREAMINFO parses', probed !== null);

      if (probed) {
        check(
          'reported sample rate matches the file',
          s.sampleRate == null || Number(s.sampleRate) === probed.sampleRate,
          `declared=${s.sampleRate} actual=${probed.sampleRate}`,
        );
        check(
          'reported bit depth matches the file',
          s.bitDepth == null || Number(s.bitDepth) === probed.bitDepth,
          `declared=${s.bitDepth} actual=${probed.bitDepth}`,
        );
        const contentRange = response.headers.get('content-range') ?? '';
        const total = Number(contentRange.split('/').pop());
        const kbps = Number.isFinite(total) ? flacKbps(total, probed.durationSec) : null;
        console.log(
          `\n        \x1b[1m${probed.sampleRate} Hz · ${probed.bitDepth}-bit · ` +
          `${probed.channels} ch · ${probed.durationSec}s` +
          `${kbps ? ` · ~${kbps} kbps` : ''}\x1b[0m`,
        );
        console.log(`        ${Number.isFinite(total) ? (total / 1e6).toFixed(1) : '?'} MB FLAC`);
        check(
          'duration matches the search row',
          target.duration == null ||
            Math.abs(target.duration - probed.durationSec) <= 2,
          `row=${target.duration}s file=${probed.durationSec}s`,
        );
      }
    } catch (error) {
      check('media URL is fetchable', false, error.message);
    }

    // ── Miss semantics ─────────────────────────────────────────────────────
    section('Miss semantics — a 404 is a signal, not a failure');
    const miss = await get('/stream/definitely-not-a-real-track-id?quality=LOSSLESS');
    check('unknown id returns 404', miss.status === 404, `status ${miss.status}`);
    check('404 body explains itself', typeof miss.json?.message === 'string',
      miss.json?.message);
  }

  // ── Summary ─────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(60)}`);
  const total = passed + failed;
  if (failed === 0) {
    console.log(`\x1b[32m✓ ${passed}/${total} checks passed\x1b[0m`);
  } else {
    console.log(`\x1b[31m✗ ${failed}/${total} failed\x1b[0m`);
    for (const f of failures) console.log(`    · ${f}`);
  }
  console.log('');
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`\n\x1b[31mcontract check could not run:\x1b[0m ${error.message}`);
  console.error(`is the addon running at ${BASE}?\n`);
  process.exit(2);
});
