#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
#  Tailor CV — one-click update (macOS / Linux)
#
#  Usage:  ./update.sh            (updates ~/tailor-cv)
#          ./update.sh /my/path   (updates a custom install folder)
#
#  Pulls the latest code and restarts the app. Your data is untouched.
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

APP_DIR="${1:-$HOME/tailor-cv}"
APP_URL="http://localhost:3000"
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BOLD='\033[1m'; NC='\033[0m'
ok()   { printf "${GREEN}✔ %s${NC}\n" "$*"; }
warn() { printf "${YELLOW}⚠ %s${NC}\n" "$*"; }
fail() { printf "${RED}✘ %s${NC}\n" "$*"; exit 1; }

printf "${BOLD}\n═══ Tailor CV updater ═══\n${NC}\n"

[ -d "$APP_DIR/.git" ] || fail "No Tailor CV install found at $APP_DIR — run the installer first."
command -v docker >/dev/null 2>&1 || fail "Docker is not installed — run the installer first."

echo "Pulling the latest code…"
git -C "$APP_DIR" pull --ff-only || fail "Could not pull the update — check your connection."
ok "Code updated"

if [ -d "$APP_DIR/config.ini" ]; then rmdir "$APP_DIR/config.ini" 2>/dev/null || true; fi
if [ ! -f "$APP_DIR/config.ini" ]; then touch "$APP_DIR/config.ini"; fi

echo "Refreshing the app…"
docker compose -f "$APP_DIR/docker-compose.yml" up -d --build --pull missing || fail "docker compose failed — see the output above."

# The host folder is bind-mounted over the image's /app, shadowing the image's
# built frontend — the server serves the HOST dist/ folder. Refresh it from
# the freshly built image so updates never land on "frontend not built".
if [ -f "$APP_DIR/dist/index.html" ] && [ -n "$(find "$APP_DIR/dist" -newer "$APP_DIR/package.json" -name index.html 2>/dev/null)" ]; then
  ok "Frontend already up to date"
else
  IMG=$(docker compose -f "$APP_DIR/docker-compose.yml" config --images 2>/dev/null | head -1)
  if [ -n "$IMG" ]; then
    echo "Refreshing the frontend in $APP_DIR/dist from the image …"
    docker run --rm -v "$APP_DIR":/out --entrypoint cp "$IMG" -r /app/dist /out/dist 2>/dev/null \
      || warn "Could not refresh the frontend — re-run the updater if you see 'frontend not built'."
  fi
fi
ok "Tailor CV updated and running"

sleep 2
open "$APP_URL" 2>/dev/null || true
printf "${BOLD}✅ Updated! The app is at ${GREEN}$APP_URL${NC}\n"
