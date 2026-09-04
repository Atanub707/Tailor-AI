FROM node:22-bookworm-slim

WORKDIR /app

# Build tools to compile better-sqlite3 against this image's glibc
# (prebuilt binaries may require a newer glibc than bookworm ships)
# git lets the app auto-update itself (pull + restart).
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ git && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --loglevel=error \
  && rm -rf node_modules/better-sqlite3/prebuilds \
  && cd node_modules/better-sqlite3 && npx node-gyp rebuild

# Build the frontend so dist/ ships inside the image. With NODE_ENV=production
# in docker-compose the server serves dist/ via express.static — without this
# step a freshly built image has no dist/ and GET / falls through to the
# bare Express "Cannot GET /" default.
COPY . .
RUN npm run build \
  && cp -r /app/dist /image-dist
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 3000

# Boot tsx DIRECTLY — no `npm run <script>` indirection (npm script lookup
# fails on Windows installs when the bind-mounted /app/package.json is
# missing/stale/CRLF-corrupted). SINGLE-STRING JSON CMD is CR-immune: on a
# CRLF Dockerfile checkout the trailing \r lands after the whole command
# instead of inside the last argument ('/app/server.ts\r' → %0D error).
# entrypoint.sh runs single-string commands via /bin/sh -c.
ENTRYPOINT ["sh", "/entrypoint.sh"]
CMD ["node --import tsx /app/server.ts"]
