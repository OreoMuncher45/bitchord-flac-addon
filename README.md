# BitChord FLAC Addon

A [BitChord](https://github.com/kushagrasinghx/BitChord) addon server that serves
**true FLAC** from catalogues that need **no account, no token and no credentials**.

Tested working against the real upstreams: search returns rows with real
durations, `/stream` returns a playable URL, and the bytes behind that URL are a
genuine FLAC file whose sample rate and bit depth this addon reads out of the
file itself rather than asserting.

```
44100 Hz · 16-bit · 2 ch · 320.36 s · ~1013 kbps · 40.6 MB FLAC
```

---

## First: this is not a SpotiFLAC extension

If you came from [OreoMuncher45/spotiflac-extensions](https://github.com/OreoMuncher45/spotiflac-extensions),
the most important thing on this page is that the repository was not misnamed —
it targeted the wrong application.

|  | SpotiFLAC Mobile | BitChord |
|---|---|---|
| Language | JavaScript | Kotlin / Android |
| Extension format | `.sflx` archive | **none** |
| Manifest fields | `minAppVersion`, `permissions`, `qualityOptions`, `searchBehavior` | `id`, `name`, `version`, `resources`, `settings` |
| How an extension loads | installed from a store registry | you paste an **HTTP URL** |
| Code execution | the app runs your `index.js` | **nothing is ever downloaded or run** |

A `.sflx` package cannot be loaded by BitChord, and no amount of renaming one will
change that. BitChord's extension mechanism is an HTTP addon protocol documented
at **[bitchord.kushagrasingh.in/docs](https://bitchord.kushagrasingh.in/docs)** —
three GET routes returning JSON. This project implements exactly that, and
nothing else.

---

## Quick start

```bash
node server.js
```

```
  Add to BitChord:  http://<this-host>:8787/manifest.json
  Health check:     http://<this-host>:8787/health
```

Then in BitChord:

> **Settings → Sources → Add an addon** → paste `http://<this-host>:8787/manifest.json`

No dependencies. Node 18.17+.

### It shows up with a name

The row in **Settings → Sources** will read:

```
FLAC Source · Tidal + Internet Archive        v1.0.0
```

That string is this addon's own `name` field, and BitChord is specific about
where it comes from: `SourceRegistry.identify` copies `manifest.name` into the
stored config's label, and `SourceConfig.displayName` reads
`label.ifBlank { host ?: kind.label }`. A blank name therefore does not *fail* —
it silently degrades to the row showing your server's hostname, which is exactly
the thing that reads as "it didn't work" when it did.

Two consequences, both deliberate:

- The name names the **configured** sources, so `SOURCES=tidal` gives
  `FLAC Source · Tidal`. An addon claiming "+ Internet Archive" while not asking
  it would be describing a catalogue it does not hold.
- Rename it and the change appears the next time you open the Sources screen.
  No need to remove and re-add the source.

---

## What it serves, and where from

| Source | Credentials | What it is | Verified |
|---|---|---|---|
| **Tidal** (via Monochrome's public index) | **none** | The commercial catalogue. `/search/tracks` for metadata, `/track/{id}` for the FLAC itself. | `fLaC` bytes, 206 range responses, `HEAD` OK |
| **Internet Archive** | **none** | Freely-licensed recordings: live tapes, bootlegs, public-domain transfers, classical and jazz sets. | `fLaC` bytes, 963,908 items indexed |

Both are CD quality — 44.1 kHz / 16-bit, which is bit-exact lossless. The Tidal
index serves the same file whichever tier is asked for, so **24-bit/96 kHz Hi-Res
is not available from it**, and this addon does not claim otherwise: the
`quality` string is generated from the header that was actually read.

Two sources that were tested and **rejected**, recorded here so nobody re-runs the
same experiment:

| Source | Why not |
|---|---|
| NetEase Cloud Music | Search works anonymously with excellent metadata, but `/api/song/enhance/player/url/v1` returns `url: null` without a login cookie. A metadata-only source is not a playback source. |
| Kuwo | `mobi.kuwo.cn` answered a FLAC request with `br=1` and served an MP3, and returned `code 407` ("not available in your region") for other tracks. |

Monochrome's *other* public instances — `api.monochrome.tf`, the five `qqdl.site`
hosts, `tidal.kinoplus.online` — are all dead as of September 2026 (DNS failure
or TLS EOF). `tracks.monochrome.st` is the one that answers. It is a
configurable base URL, so it can be repointed without a code change:

```bash
TIDAL_BASE_URL=https://some-other-instance.example node server.js
```

---

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | listen port |
| `HOST` | `0.0.0.0` | bind address |
| `SOURCES` | `tidal,archive` | which sources to ask, in priority order |
| `PROXY` | `0` | `1` to serve audio through this host |
| `ADDON_TOKEN` | unset | if set, `?token=` is required on every route |
| `TIDAL_BASE_URL` | `https://tracks.monochrome.st` | the Tidal-backed index |

Run Tidal alone — the fastest possible search, since the Archive's fan-out is
what makes `/search` slow:

```bash
SOURCES=tidal node server.js
```

---

## Two decisions worth explaining

### Quality claims are read, not asserted

BitChord does not take a source's word for it. `AddonSource.formatOf` reads the
codec you declare, but `StreamFormat.isLossless` and the whole quality ranking
that follows are settled against **what the device actually decodes**. The spec
puts it plainly: *"A lossless label on a lossy URL does not create a lossless
badge."*

The catalogues here do not describe themselves — the Tidal one answers FLAC as
`application/octet-stream` with nothing about the audio inside. So before every
`/stream` response this addon makes a 42-byte range request, parses the FLAC
`STREAMINFO` block, and reports what the file says:

```
sampleRate: 44100,  bitDepth: 16,  bitrate: 1013
```

Where the header cannot be read, those fields are **absent** rather than filled
with a plausible number. BitChord reads an absent field as "unknown", which is
true, and reads a wrong one as a claim, which is not.

### Audio is not proxied by default

BitChord opens the URL `/stream` returns directly. That keeps a 40 MB FLAC off
this process entirely: no bandwidth, no buffering, no second place for a
connection to fail. For a phone on a metered plan, that is the right default.

Set `PROXY=1` to serve audio through this host instead. It buys two things — a
real `.flac` path and an `audio/flac` content type, so Media3 can infer the
extractor without sniffing — at the cost of moving every byte through this
machine. Range requests are forwarded verbatim either way; a proxy that dropped
`Range` would turn every seek into a full re-fetch.

In proxy mode this process is the one asserting `audio/flac`, so it checks the
four signature bytes before passing anything on and answers 502 rather than
serve an HTML error page as audio.

---

## A caveat about the upstream, measured

The Tidal index **closes any single transfer after about 30 seconds**, whether or
not this addon is in the path:

```
upstream, no Range:        30.6s / 30.4s / 30.4s — 35 MB, 29 MB, 5 MB of 40.6 MB
upstream, Range: bytes=0-:  1.2s / 30.4s / 30.7s — same cutoff
```

That is a CDN timeout at the far end, and it is upstream behaviour rather than
anything this addon does — the numbers above are from requests that never
touched it. It is also unlikely to matter in practice, because a player reads
sequentially with bounded range requests rather than one 40 MB `GET`. Measured
against 4 MB chunks, the upstream is also noticeably flaky (7 of 11 succeeded on
a clean run), which is the more likely thing to be felt: an occasional track that
does not start, which BitChord handles by falling through to YouTube Music.

If a track fails to play, `scripts/contract-check.js` will tell you whether the
addon is at fault or the upstream is. Short ranged reads — the ones a player
actually makes — are reliable; long single reads are not.

---

## Verify it yourself

Two layers, both of which are meant to fail loudly.

**Unit tests** — the FLAC parser, the id codec, the caches. No network:

```bash
npm test
```

**Contract check** — runs against a live addon and asserts the rules BitChord
actually enforces, then downloads the first bytes of a real stream and checks
they are `fLaC`:

```bash
node scripts/contract-check.js http://localhost:8787
```

```
  PASS  codec is one BitChord recognises  codec="flac"
  PASS  does not declare a manifest transport for progressive audio  manifest="none"
  PASS  bytes begin with fLaC  magic="fLaC"
  PASS  reported sample rate matches the file  declared=44100 actual=44100
  PASS  reported bit depth matches the file  declared=16 actual=16
  PASS  supports range requests (BitChord seeks)  Accept-Ranges=bytes
  PASS  duration matches the search row  row=320.4s file=320.36s

        44100 Hz · 16-bit · 2 ch · 320.36s · ~1013 kbps
        40.6 MB FLAC
✓ 30/30 checks passed
```

That last part is the point of the file. A source can satisfy every structural
rule in the protocol while serving a 320 kbps MP3 under a `LOSSLESS` label, and
nothing in the protocol will catch it.

---

## Latency

| Route | Cold | Warm | Budget |
|---|---|---|---|
| `/manifest.json` | 7 ms | — | — |
| `/search` | 2–5 s | ~0 ms | 15 s ceiling, 5 s per Archive query |
| `/stream/{id}` | 0.2–4 s | ~0 ms | 15 s ceiling |

`/search` is dominated by the Internet Archive, which needs a query plus a
bounded fan-out over item file listings. It is given a 5-second budget of its own
so it cannot decide the latency of the whole addon, and exceeding that budget
returns whatever rows arrived — a partial answer, not a failure. `SOURCES=tidal`
brings `/search` down to about 1.6 s.

Probes and catalogue answers are cached; see `lib/http.js` for why a *failed*
probe is deliberately not cached.

---

## Deploying

See **[DEPLOY.md](DEPLOY.md)** for Fly.io, a plain VPS, Docker, and running it on
a home network for your own phone.

BitChord needs HTTPS for a host it can reach from a phone off your Wi-Fi — put it
behind any TLS-terminating proxy (Caddy, nginx, Cloudflare) if you do not have one.

---

## Layout

```
server.js                    the three addon routes, plus /health and the proxy
lib/flac.js                  STREAMINFO parsing — how a quality claim is made honest
lib/http.js                  timeouts, retries, caching, partial-failure handling
lib/trackid.js               ids that survive being put in a URL path segment
lib/sources/tidal.js         Tidal via Monochrome's public index
lib/sources/archive.js       Internet Archive
scripts/contract-check.js    live check against the rules BitChord enforces
test/unit.test.js            parser, id codec, cache semantics
```

Adding a source means writing one file exporting `search`, `resolve`, `mediaUrl`
and `health`, and adding it to the `REGISTRY` map in `server.js`. It is called in
parallel with the others and its failure never fails a search.

---

## Legal

This addon is a client. It stores no audio, hosts nothing, and serves no DRM. It
requests public catalogue endpoints from services you access on your own
account-free footing, and what you do with the result is between you and your
local law and the terms of those services. Not affiliated with or endorsed by
BitChord, Tidal, Monochrome, or the Internet Archive.
