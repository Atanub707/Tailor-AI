#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
#  Tailor CV — one-click installer (macOS / Linux)
#
#  Usage:  ./install.sh            (installs to ~/tailor-cv)
#          ./install.sh /my/path   (installs to a custom folder)
#
#  What it does (idempotent — safe to re-run):
#    1. Checks for Docker → installs Docker Desktop via Homebrew if missing
#    2. Starts the Docker engine and waits until it is ready
#    3. Downloads Tailor CV (git clone) if not present
#    4. Runs `docker compose up -d` and opens the app in your browser
#
#  No code-signing needed: you run Docker Desktop (signed by Docker Inc),
#  so macOS shows no warnings about this app.
#  Full guide: see scripts/README.md
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

APP_DIR="${1:-$HOME/tailor-cv}"
REPO_URL="https://github.com/Atanub707/Tailor-AI.git"
APP_URL="http://localhost:3000"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BOLD='\033[1m'; NC='\033[0m'
ok()   { printf "${GREEN}✔ %s${NC}\n" "$*"; }
warn() { printf "${YELLOW}⚠ %s${NC}\n" "$*"; }
fail() { printf "${RED}✘ %s${NC}\n" "$*"; exit 1; }

printf "${BOLD}\n═══ Tailor CV installer ═══\n${NC}\n"

# ── 1. Port check — already running? ────────────────────────────────────────
if curl -s -o /dev/null -m 2 "$APP_URL" 2>/dev/null; then
  warn "Tailor CV is already running at $APP_URL — nothing to do."
  open "$APP_URL" 2>/dev/null || true
  exit 0
fi

# ── 2. Docker CLI ───────────────────────────────────────────────────────────
if command -v docker >/dev/null 2>&1; then
  ok "Docker CLI found"
else
  echo "Docker not found — installing Docker Desktop (signed by Docker Inc, no warnings)…"
  if ! command -v brew >/dev/null 2>&1; then
    warn "Homebrew not found — installing it first (takes a few minutes)…"
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null || /usr/local/bin/brew shellenv 2>/dev/null)"
  fi
  brew install --cask docker || fail "Could not install Docker Desktop via Homebrew."
  ok "Docker Desktop installed"
fi

# Compose v2 (bundled with Docker Desktop)?
docker compose version >/dev/null 2>&1 || fail "docker compose v2 is missing — update Docker Desktop."

# ── 3. Docker engine ────────────────────────────────────────────────────────
if ! docker info >/dev/null 2>&1; then
  echo "Starting Docker Desktop…"
  open -a Docker 2>/dev/null || warn "Could not launch Docker Desktop — please start it manually."
  echo "Waiting for the Docker engine (first launch can take a minute)…"
  ready=0
  for _ in $(seq 1 90); do
    if docker info >/dev/null 2>&1; then ready=1; break; fi
    printf "."; sleep 2
  done
  printf "\n"
  [ "$ready" = "1" ] || fail "The Docker engine did not start. Open Docker Desktop once, let it finish, then rerun this installer."
  ok "Docker engine is ready"
fi

# ── 4. Get the app ──────────────────────────────────────────────────────────
if [ ! -f "$APP_DIR/docker-compose.yml" ]; then
  # A folder exists but the app isn't there → stale/partial install. git clone
  # refuses to clone into a non-empty directory, so clean it (preserve config.ini).
  if [ -e "$APP_DIR" ]; then
    warn "A previous incomplete install was found at $APP_DIR — cleaning it up before downloading fresh."
    if [ -f "$APP_DIR/config.ini" ]; then
      cp "$APP_DIR/config.ini" "${TMPDIR:-/tmp}/tailor-cv-config.ini.bak" 2>/dev/null || true
      warn "Your existing config.ini (API keys) was backed up and will be restored."
    fi
    rm -rf "$APP_DIR"
  fi
  echo "Downloading Tailor CV…"
  command -v git >/dev/null 2>&1 || fail "git is required. Install it (brew install git) and rerun."
  mkdir -p "$APP_DIR"
  git clone --depth 1 "$REPO_URL" "$APP_DIR" || fail "Could not download the app. Check your connection, or clone $REPO_URL manually."
  ok "App downloaded to $APP_DIR"
fi

# Restore a backed-up config.ini so API keys survive a stale-folder cleanup.
if [ -f "${TMPDIR:-/tmp}/tailor-cv-config.ini.bak" ] && [ ! -f "$APP_DIR/config.ini" ]; then
  cp "${TMPDIR:-/tmp}/tailor-cv-config.ini.bak" "$APP_DIR/config.ini" 2>/dev/null || true
  rm -f "${TMPDIR:-/tmp}/tailor-cv-config.ini.bak"
  ok "Restored your previous config.ini (API keys kept intact)"
fi

# ── 5. Prepare config.ini (Docker mounts a missing file as a DIRECTORY — that
# would silently break settings saves; create the empty file first) ──────────
if [ -d "$APP_DIR/config.ini" ]; then rmdir "$APP_DIR/config.ini" 2>/dev/null || true; fi
if [ ! -f "$APP_DIR/config.ini" ]; then touch "$APP_DIR/config.ini"; fi

# ── 6. Run ──────────────────────────────────────────────────────────────────
echo "Starting Tailor CV…"
docker compose -f "$APP_DIR/docker-compose.yml" up -d --build --pull missing || fail "docker compose failed — see the output above."

# The host folder is bind-mounted over the image's /app, which SHADOWS the
# image's built frontend. The server therefore serves the frontend from the
# HOST dist/ folder — seed it from the image (no Node needed on this machine).
# Without this, first-time installs hit the "frontend not built" page.
if [ -f "$APP_DIR/dist/index.html" ]; then
  ok "Frontend already present on disk"
else
  IMG=$(docker compose -f "$APP_DIR/docker-compose.yml" config --images 2>/dev/null | head -1)
  if [ -n "$IMG" ]; then
    echo "Copying the built frontend from the image into $APP_DIR/dist …"
    docker run --rm -v "$APP_DIR":/out --entrypoint cp "$IMG" -r /app/dist /out/dist 2>/dev/null \
      || warn "Could not copy the frontend — the app may show 'frontend not built'. Re-run the installer, or run 'npm run build' inside $APP_DIR."
  fi
fi
ok "Tailor CV is running"

sleep 2
echo "Opening $APP_URL in your browser…"
open "$APP_URL" 2>/dev/null || true

printf "${BOLD}\n──────────────────────────────────────────────\n${NC}"
printf "${BOLD}✅ Tailor CV is ready at ${GREEN}$APP_URL${NC}\n"
printf "${BOLD}   Sign in or continue as guest, then set your AI key:\n"
printf "${BOLD}   top-right menu → Settings → Integrations → LLM & AI${NC}\n"
printf "${BOLD}   Stop it:  docker compose -f $APP_DIR/docker-compose.yml down\n"
printf "${BOLD}   Update:   curl -fsSL https://github.com/Atanub707/Tailor-AI/raw/main/scripts/update.sh | bash\n"
printf "${BOLD}   Uninstall: curl -fsSL https://github.com/Atanub707/Tailor-AI/raw/main/scripts/uninstall.sh | bash\n"
printf "${BOLD}──────────────────────────────────────────────\n${NC}"
