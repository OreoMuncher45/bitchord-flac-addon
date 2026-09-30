import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parseFlacStreamInfo, flacKbps, STREAMINFO_BYTES } from '../lib/flac.js';
import { encodePart, decodePart, makeTrackId, parseTrackId } from '../lib/trackid.js';
import { parseTier, TtlCache, settleAll, cleanSegment } from '../lib/http.js';

/**
 * Builds a real FLAC STREAMINFO header.
 *
 * Constructing the bytes by hand rather than pasting a hex dump is what keeps
 * this a test of the parser instead of a test of one fixture: a fixture cannot
 * distinguish a parser that reads bit 44 from one that happens to agree with it
 * on a single sample.
 */
function flacHeader({
  sampleRate = 44100,
  channels = 2,
  bitDepth = 16,
  totalSamples = 44100 * 180,
  blockType = 0,
  lastBlock = false,
} = {}) {
  const head = Buffer.alloc(STREAMINFO_BYTES);
  head.write('fLaC', 0, 'ascii');

  head[4] = (lastBlock ? 0x80 : 0) | blockType;
  head.writeUIntBE(34, 5, 3); // STREAMINFO length is always 34

  const body = head.subarray(8);
  body.writeUInt16BE(4096, 0); // min block size
  body.writeUInt16BE(4096, 2); // max block size
  body.writeUIntBE(2284, 4, 3); // min frame size
  body.writeUIntBE(14508, 7, 3); // max frame size

  const packed =
    (BigInt(sampleRate) << 44n) |
    (BigInt(channels - 1) << 41n) |
    (BigInt(bitDepth - 1) << 36n) |
    (BigInt(totalSamples) & 0xfffffffffn);
  body.writeBigUInt64BE(packed, 10);

  return head;
}

describe('parseFlacStreamInfo', () => {
  test('reads a CD-quality stereo header', () => {
    const info = parseFlacStreamInfo(
      flacHeader({ sampleRate: 44100, channels: 2, bitDepth: 16 }),
    );
    assert.equal(info.sampleRate, 44100);
    assert.equal(info.channels, 2);
    assert.equal(info.bitDepth, 16);
    assert.ok(Math.abs(info.durationSec - 180) < 0.001);
  });

  test('reads a hi-res header — 24-bit/96 kHz, the case that breaks naive shifts', () => {
    const info = parseFlacStreamInfo(
      flacHeader({ sampleRate: 96000, channels: 2, bitDepth: 24, totalSamples: 96000 * 300 }),
    );
    assert.equal(info.sampleRate, 96000);
    assert.equal(info.bitDepth, 24);
    assert.equal(info.channels, 2);
    assert.ok(Math.abs(info.durationSec - 300) < 0.001);
  });

  test('reads multichannel — 5.1 and 7.1 exercise the 3-bit channel field', () => {
    assert.equal(parseFlacStreamInfo(flacHeader({ channels: 6 })).channels, 6);
    assert.equal(parseFlacStreamInfo(flacHeader({ channels: 8 })).channels, 8);
  });

  test('reads a 32-bit header, the top of the field', () => {
    assert.equal(parseFlacStreamInfo(flacHeader({ bitDepth: 32 })).bitDepth, 32);
  });

  test('reads 192 kHz, which is where the 20-bit rate field ends', () => {
    assert.equal(parseFlacStreamInfo(flacHeader({ sampleRate: 192000 })).sampleRate, 192000);
  });

  test('rejects bytes that are not FLAC', () => {
    assert.equal(parseFlacStreamInfo(Buffer.from('ID3\x04\x00\x00\x00')), null,
      'an MP3 with an ID3 tag must not parse');
    assert.equal(parseFlacStreamInfo(Buffer.from('\x00\x00\x00\x00')), null);
    assert.equal(parseFlacStreamInfo(Buffer.from('fLa')), null, 'too short');
    assert.equal(parseFlacStreamInfo(null), null);
  });

  test('rejects a FLAC whose first block is not STREAMINFO', () => {
    // Legal FLAC, unreadable cheaply. Returning the numbers of the block that is
    // there would be worse than returning nothing.
    assert.equal(parseFlacStreamInfo(flacHeader({ blockType: 4 })), null,
      'VORBIS_COMMENT first');
    assert.equal(parseFlacStreamInfo(flacHeader({ blockType: 6 })), null, 'PICTURE first');
  });

  test('rejects a header with no usable sample rate', () => {
    assert.equal(parseFlacStreamInfo(flacHeader({ sampleRate: 0 })), null);
  });
});

describe('flacKbps', () => {
  test('computes a rate from size and duration', () => {
    // 40 MB over 320 s is about 1013 kbps.
    assert.equal(flacKbps(40_572_194, 320.36), 1013);
  });

  test('returns null rather than a wrong number', () => {
    assert.equal(flacKbps(0, 100), null);
    assert.equal(flacKbps(1000, 0), null);
    assert.equal(flacKbps(NaN, 100), null);
  });
});

describe('track ids', () => {
  test('passes an already-safe id through unchanged, so logs stay readable', () => {
    assert.equal(encodePart('154049681742106624'), '154049681742106624');
    assert.equal(makeTrackId('tidal', '154049681742106624'), 'tidal:154049681742106624');
  });

  test('encodes anything that could break a path segment', () => {
    // A `/` here becomes `%2F` on the wire and is decoded back to a delimiter by
    // the receiving server, which is the whole reason for encoding.
    const nasty = '1959-03-05 The Veldt (dramatized)/Part 2.flac';
    const encoded = encodePart(nasty);
    assert.ok(!encoded.includes('/'), 'must not contain a delimiter');
    assert.ok(!/[?#\s]/.test(encoded), 'must not contain query or space characters');
    assert.equal(decodePart(encoded), nasty);
  });

  test('round-trips a wide spread of awkward filenames', () => {
    for (const value of [
      'simple.flac',
      'with space.flac',
      'with/slash.flac',
      'with?question.flac',
      'with#hash.flac',
      '日本語のタイトル.flac',
      'emoji 🎵.flac',
      'a'.repeat(300) + '.flac',
    ]) {
      assert.equal(decodePart(encodePart(value)), value);
    }
  });

  test('never produces a segment BitChord would split', () => {
    for (const value of ['a/b', 'a?b', 'a#b', 'a b']) {
      assert.equal(makeTrackId('archive', value).includes('?'), false);
      assert.ok(!/[?#\s]/.test(makeTrackId('archive', value)));
    }
  });

  test('parses a round-tripped id back to source and handle', () => {
    const parsed = parseTrackId(makeTrackId('tidal', '154049681742106624'));
    assert.deepEqual(parsed, { source: 'tidal', nativeId: '154049681742106624' });
  });

  test('rejects ids this addon never issued', () => {
    assert.equal(parseTrackId(''), null);
    assert.equal(parseTrackId('no-separator'), null);
    assert.equal(parseTrackId(':leading-colon'), null);
    assert.equal(parseTrackId('tidal:'), null);
  });
});

describe('parseTier', () => {
  test('reads BitChord native tiers', () => {
    assert.equal(parseTier('LOSSLESS'), 'LOSSLESS');
    assert.equal(parseTier('HIGH'), 'HIGH');
    assert.equal(parseTier('LOW'), 'LOW');
  });

  test('reads the spellings its own manifest can declare', () => {
    assert.equal(parseTier('lossless'), 'LOSSLESS');
    assert.equal(parseTier('flac'), 'LOSSLESS');
    assert.equal(parseTier('hires'), 'LOSSLESS');
    assert.equal(parseTier('hi-res'), 'LOSSLESS');
    assert.equal(parseTier('320'), 'HIGH');
    assert.equal(parseTier('128'), 'LOW');
  });

  test('defaults to lossless, the only tier an addon here can serve', () => {
    assert.equal(parseTier(''), 'LOSSLESS');
    assert.equal(parseTier(null), 'LOSSLESS');
    assert.equal(parseTier('something-else'), 'LOSSLESS');
  });
});

describe('TtlCache', () => {
  test('expires an entry', () => {
    const cache = new TtlCache();
    cache.set('k', 'v', 5);
    assert.equal(cache.get('k'), 'v');
    return new Promise((r) => setTimeout(r, 15)).then(() => {
      assert.equal(cache.get('k'), undefined);
    });
  });

  test('does not cache a null result, so a transient failure is retried', () => {
    // The bug this guards: a probe that timed out once must not strip a track
    // of its bit depth for the life of the process.
    const cache = new TtlCache();
    let calls = 0;
    const produce = async () => {
      calls++;
      return calls < 3 ? null : 'recovered';
    };
    return Promise.resolve()
      .then(() => cache.wrap('k', 60_000, produce))
      .then((first) => {
        assert.equal(first, null);
        return cache.wrap('k', 60_000, produce);
      })
      .then((second) => {
        assert.equal(second, null, 'still failing, still not cached');
        return cache.wrap('k', 60_000, produce);
      })
      .then((third) => {
        assert.equal(third, 'recovered', 'a success is now cached');
        return cache.wrap('k', 60_000, produce);
      })
      .then((fourth) => {
        assert.equal(fourth, 'recovered', 'a success is served from cache');
        assert.equal(calls, 3, 'the fourth ask did not reach the producer');
      });
  });

  test('stays bounded', () => {
    const cache = new TtlCache(20);
    for (let i = 0; i < 200; i++) cache.set(`k${i}`, i, 60_000);
    assert.ok(cache.size <= 20, `size was ${cache.size}`);
  });
});

describe('settleAll', () => {
  test('never rejects, so one dead source cannot fail a search', async () => {
    const results = await settleAll([
      async () => 'a',
      async () => {
        throw new Error('source is down');
      },
      async () => 'c',
    ]);
    assert.equal(results.length, 3);
    assert.equal(results[0].value, 'a');
    assert.equal(results[1].ok, false);
    assert.equal(results[1].error.message, 'source is down');
    assert.equal(results[2].value, 'c');
  });

  test('preserves input order regardless of completion order', async () => {
    const results = await settleAll([
      async () => {
        await new Promise((r) => setTimeout(r, 30));
        return 'slow';
      },
      async () => 'fast',
    ]);
    assert.equal(results[0].value, 'slow');
    assert.equal(results[1].value, 'fast');
  });
});

describe('cleanSegment', () => {
  test('strips control characters that would corrupt a URL', () => {
    assert.equal(cleanSegment('a bc'), 'abc');
    assert.equal(cleanSegment('  spaced  '), 'spaced');
  });
});
