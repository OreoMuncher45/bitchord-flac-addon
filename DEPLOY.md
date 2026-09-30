# Deploying

BitChord has to be able to reach this server from a phone. Pick whichever of the
four below matches where you want it to live.

**BitChord requires HTTPS** for any host that is not `localhost`. A phone on
cellular data is not on your LAN, so an add-on bound to `0.0.0.0:8787` on your
laptop is reachable at `http://192.168.1.x:8787` and nowhere else.

---

## 1. Fly.io — cheapest way to get a public HTTPS URL

```bash
npm i -g flyctl
fly launch --no-deploy --name bitchord-flac-addon
fly deploy
```

`fly deploy` picks a public HTTPS hostname automatically:

```
https://bitchord-flac-addon.fly.dev
```

Paste `…/manifest.json` into BitChord. Check it:

```bash
curl https://bitchord-flac-addon.fly.dev/health
```

Audio is **not** proxied by default, so the machine serves almost no bandwidth —
just three small JSON routes and one 42-byte range request per track.

---

## 2. A VPS with Caddy

The only real prerequisite is a domain pointed at the box.

```bash
git clone <your-repo> bitchord-flac-addon && cd bitchord-flac-addon

sudo apt install -y nodejs npm
sudo npm i -g pm2

pm2 start server.js --name bitchord-flac-addon
pm2 save
```

`/etc/caddy/Caddyfile`:

```
flac.example.com {
    reverse_proxy localhost:8787
}
```

```bash
sudo systemctl reload caddy
```

Caddy provisions the certificate itself. Done.

---

## 3. Docker

No `Dockerfile` is committed because there is nothing to build — the whole thing
is one file and its own libraries. If you want one anyway:

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY server.js ./
COPY lib ./lib
ENV PORT=8787 HOST=0.0.0.0
EXPOSE 8787
CMD ["node", "server.js"]
```

```bash
docker build -t bitchord-flac-addon .
docker run -d --name flac-addon -p 8787:8787 --restart unless-stopped bitchord-flac-addon
```

Then put TLS in front of it, as above.

---

## 4. Your own network — quickest, and free

Good enough to answer the question this project exists to answer: *can this
device play FLAC at all?*

```bash
SOURCES=tidal node server.js
```

Find your LAN address:

```bash
# macOS / Linux
ipconfig getifaddr en0

# Windows
ipconfig | Select-String "IPv4"
```

In BitChord, add:

```
http://192.168.1.x:8787/manifest.json
```

Plain HTTP is fine on your own Wi-Fi, and BitChord will take it. No token needed
for a home network, though you can set one:

```bash
ADDON_TOKEN=$(openssl rand -hex 16) SOURCES=tidal node server.js
# then paste:
http://192.168.1.x:8787/manifest.json?token=…
```

BitChord keeps the token in the URL you paste and appends it to every subsequent
call, so you only ever type it once.

---

## Operating it

### Health

```bash
curl -s http://localhost:8787/health | jq
```

```json
{
  "addon": "FLAC Source",
  "proxyAudio": false,
  "sources": [
    { "id": "tidal",   "ok": true, "detail": "1 result(s) for a probe query" },
    { "id": "archive", "ok": true, "detail": "963,908 FLAC items indexed" }
  ]
}
```

One line of JSON per request, and a line per search naming the tier and the row
count:

```json
{"level":"info","msg":"stream","id":"tidal:155102871061270528","tier":"LOSSLESS",
 "source":"tidal","probed":true,"sampleRate":44100,"bitDepth":16}
```

`"probed": true` means the FLAC header really was read. `"probed": false` means
the audio resolved but its format could not be confirmed — worth a look if it
happens often.

### After an upstream changes

Nothing to redeploy. BitChord re-reads `/manifest.json` every 10 minutes, and
catalogue and probe results are cached in-process, so the first track after a
restart picks up a change upstream.

If the Tidal index moves, repoint it without a code change and restart:

```bash
TIDAL_BASE_URL=https://new-host.example pm2 restart bitchord-flac-addon
```

### Which source is answering

```bash
curl -s 'http://localhost:8787/search?q=hotel+california&quality=LOSSLESS' \
  | jq -r '.tracks[] | "\(.id|split(":")[0])  \(.artist) — \(.title)"'
```

```
tidal     Eagles — Hotel California - 2013 Remaster
archive   BBC Radio — 1959-03-05 The Veldt (dramatized by Jack Pulman)
```

The Archive's own relevance is weak by nature — it indexes 963,908 FLAC items and
its ranking is popularity, not similarity — so rows from it are worth treating as
a fallback. It is configured last for exactly that reason.
