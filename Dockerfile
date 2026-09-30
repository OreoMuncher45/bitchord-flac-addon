# BitChord FLAC Addon — image
#
# There is nothing to compile: the addon is one entry point and its own
# libraries, with no dependencies. The build exists to pin a Node version and
# to give `fly deploy` something to run.

FROM node:22-alpine

WORKDIR /app

# No `npm ci` step, deliberately. package.json declares zero dependencies and
# there is no lockfile to install from, so a dependency-install step would be a
# network round trip that can fail for no benefit. If a dependency is ever
# added, this line becomes `COPY package*.json ./` + `RUN npm ci --omit=dev`.

COPY package.json ./
COPY server.js ./
COPY lib ./lib

ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    SOURCES=tidal,archive \
    PROXY=0

EXPOSE 8787

USER node

HEALTHCHECK --interval=60s --timeout=10s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
