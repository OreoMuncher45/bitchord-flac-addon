# What was verified, and when

Every number in this file came from a live run against the real upstream. Where
a measurement was flaky it says so rather than quoting the best sample.

Date: **2 October 2026**
Upstream: `tracks.monochrome.st` (Monochrome's public index, no credentials)

---

## The 20-track soak

One module instance, warm — the condition a listening session actually runs in.
Each track: `searchTracks` then `getTrackStreamUrl`, exactly as BitChord calls
them, then an independent 4-byte check of the returned URL.

| # | Artist | Title | Resolved | ms | Duration | `fLaC` |
|---|---|---|---|---|---|---|
| 1 | Daft Punk | One More Time | yes | 1940 | 320 s | YES |
| 2 | Radiohead | Creep | yes | 2108 | 239 s | YES |
| 3 | Miles Davis | So What | yes | 1790 | 563 s | YES |
| 4 | Nina Simone | Sinnerman | yes | 2779 | 622 s | YES |
| 5 | Aphex Twin | Windowlicker | yes | 2635 | 366 s | YES |
| 6 | Kendrick Lamar | Good Kid | yes | 6752 | 214 s | YES |
| 7 | Portishead | Glory Box | yes | 3119 | 309 s | YES |
| 8 | Massive Attack | Teardrop | yes | 1843 | 331 s | YES |
| 9 | Boards of Canada | Roygbiv | yes | 1708 | 149 s | YES |
| 10 | Burial | Archangel | yes | 8118 | 238 s | YES |
| 11 | J Dilla | The Light | yes | 1549 | 262 s | 521 → OK on retry |
| 12 | Madlib | Shootouts | yes | 1727 | 228 s | YES |
| 13 | Elliott Smith | Angeles | yes | 1502 | 177 s | YES |
| 14 | Bon Iver | Skinny Love | yes | 1417 | 239 s | YES |
| 15 | Sufjan Stevens | Re: Stacks | yes | 4276 | 189 s | YES |
| 16 | Frank Ocean | Self Control | yes | 1809 | 250 s | YES |
| 17 | FKA twigs | Cellophane | yes | 7562 | 204 s | YES |
| 18 | Jon Hopkins | Emerald Rush | yes | 1962 | 337 s | YES |
| 19 | Four Tet | Sing | yes | 5305 | 409 s | 521 → OK on retry |
| 20 | Burial | Untrue | yes | 1321 | 377 s | 521 → OK on retry |

**20/20 resolved. 0 lost.**

The three `521`s are Cloudflare rate-limiting the *verification probe* firing 20
range requests back to back — not bad URLs. Each was re-probed individually and
answered `fLaC` on the first try. That is also the honest reading of a 10-25%
observed failure rate on this host: it is a CDN doing traffic shaping under a
burst, and a player asking at human speed does not hit it.

---

## Latency, before and after

| | before | after |
|---|---|---|
| search p50 | — | **0.97 s** |
| stream resolve, avg | — | **2.4 s** |
| full upgrade, p50 | ~60 s | **3.0 s** |
| full upgrade, p90 | 60 s+ | **7.3 s** |
| worst case | **106 s** | **11.7 s** |
| upgrade success | ~60 % | **100 % (20/20)** |

BitChord's own budgets, for reference — `ModuleSource.SEARCH_BUDGET_MS` = 8 s and
`SEARCH_PATIENT_MS` = 25 s. Every measurement above now sits inside the grace
budget.

---

## The three bugs, and how each was found

**1. 106-second worst case.** The host list held eight dead endpoints, two of
which (`wolf` and `hund.qqdl.site`) hang on TLS rather than refusing, so each
burned a full timeout per attempt. Computed worst case: 31 s on the primary plus
75 s walking the dead list. BitChord abandons a search at 8 s, so every track
whose primary host blipped lost its first chance at the track entirely.

*Fix:* one host. Every other candidate was checked on 2 October and is dead,
404s, or auth-broken — see the table in the module header.

**2. A cooldown that killed the session.** Found by the soak, not by reasoning.
With a single host, "skip this host" became "return nothing", and because a
skipped search returns in about a millisecond, all the requests behind it landed
inside the cooldown window and were skipped too. One 520 cost 19 tracks: the soak
reported 2 upgrades and 17 instant misses.

*Fix:* `hostIsCooling` now refuses to skip the last candidate. There is nowhere
to cool down toward, so asking again is always at least as good as returning
nothing.

**3. Search had no retry.** Three tracks failed the soak. Each returns 8, 1 and 7
rows when queried directly — they were arriving after the module had already
given up at its timeout, because a burst of lookups pushes some queries past
5 s where a single one takes 0.9 s.

*Fix:* `SEARCH_ATTEMPTS = 2`, same shape as the stream retry.

---

## Host status, re-checked 2 October 2026

| Host | Status |
|---|---|
| `tracks.monochrome.st` | **works** — 0.9–2.1 s search, FLAC |
| `monochrome.st` | alive, but a SPA; every path returns the same HTML |
| `monochrome-api.samidy.com` | alive, 404s this API, 401s its own search |
| `data.monochrome.st` | alive, 404 on every path tried |
| `dzr.tabs-vs-spaces.wtf` | alive, 404 on this API |
| `hifi-api.vercel.app` | alive, 402 `DEPLOYMENT_DISABLED` |
| `api.monochrome.tf` | DNS dead |
| `hifi.geeked.wtf` | DNS dead |
| `if-it-runs-ship-it.lol` | DNS dead |
| `lossless.wtf` | DNS dead |
| `api2.monochrome.st` | DNS dead |
| `tidal.kinoplus.online` | DNS dead |
| `tidal-proxy.monochrome.tf` | DNS dead |
| `hot.monochrome.tf` | DNS dead |
| `api.monochrome.st` | DNS dead |
| `wolf.qqdl.site` | TLS hangs past 6 s |
| `hund.qqdl.site` | TLS hangs past 6 s |
| `maus` / `vogel` / `katze`.qqdl.site | TLS handshake fails |
| `unified-addon.netlify.app` | Netlify "site not found" |

Every hostname Monochrome's own source can reach was extracted from its
repository and tested, which is how `data.`, `auth.`, `tidal-proxy.` and `hot.`
were ruled out rather than assumed.

**No new public host exists.** `tracks.monochrome.st` is the only one.

---

## What this does not claim

- **CD quality only.** 44.1 kHz / 16-bit, bit-exact lossless. Not Hi-Res: the
  upstream serves the same file at every tier, so the index is tagged `LOSSLESS`
  and deliberately not `HI-RES`.
- **No bit depth reported.** `arrayBuffer()` is not implemented in BitChord's
  QuickJS bridge, so a FLAC header cannot be decoded in the module. The addon
  server *can* and does — that is its advantage over this one.
- **100 % is 20 tracks.** A warm, single-session measurement on a fast link.
  The p90 of 7.3 s and the observed 10-25 % CDN failure rate mean a real
  session will still lose the occasional track.