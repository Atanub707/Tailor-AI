#!/bin/sh
# Tailor AI container entrypoint.
#
# The compose file bind-mounts the host folder over /app (needed for the
# in-app auto-update), which SHADOWS the frontend baked into the image at
# /app/dist. The server serves /app/dist, so on a fresh clone (no dist/ on
# the host) the app would show "frontend not built".
#
# Self-heal: if /app/dist is missing/empty, copy the image's pristine build
# (kept at /image-dist, outside the shadowed path) into it at startup.
# This covers every install path — installer scripts, ZIP downloads, manual
# docker compose — with no Node needed on the host.
if [ ! -f /app/dist/index.html ] && [ -f /image-dist/index.html ]; then
  echo "[entrypoint] Seeding frontend into /app/dist from the image build…"
  mkdir -p /app/dist
  cp -r /image-dist/. /app/dist/
fi

exec "$@"