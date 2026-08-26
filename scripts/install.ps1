# ═══════════════════════════════════════════════════════════════════════════
#  Tailor CV — one-click installer (Windows)
#
#  Run via the copy-paste one-liner (irm | iex) or install.bat.
#  Idempotent — safe to rerun.
#
#  Architecture:
#    1. Check Docker CLI → install Docker Desktop via winget if missing
#    2. Install WSL2 if missing (first-time machines; may need one reboot)
#    3. START Docker Desktop explicitly
#    4. WAIT until the Docker engine is actually ready (docker info)
#    5. Verify docker compose v2
#    6. Download Tailor CV (git clone) if not present
#    7. Run docker compose up -d
#    8. Verify the app is healthy (HTTP check)
#
#  No code-signing needed: you run Docker Desktop (signed by Docker Inc),
#  so SmartScreen shows no warnings about this app.
# ═══════════════════════════════════════════════════════════════════════════
# NEVER use Stop: PowerShell 7.3+ makes native stderr (e.g. Docker's error
# output) a TERMINATING error under Stop — killing the installer before the
# engine wait loop runs. We check $LASTEXITCODE explicitly everywhere instead.
$ErrorActionPreference = 'Continue'
$PSNativeCommandUseErrorActionPreference = $false

$AppDir  = Join-Path $env:USERPROFILE 'tailor-cv'
$RepoUrl = 'https://github.com/Atanub707/Tailor-AI.git'
$AppUrl  = 'http://localhost:3000'
$DockerDesktopExe = Join-Path ${env:ProgramFiles} 'Docker\Docker\Docker Desktop.exe'
$DockerCliPath    = Join-Path ${env:ProgramFiles} 'Docker\Docker\resources\bin\docker.exe'
$GitCliPath       = Join-Path ${env:ProgramFiles} 'Git\cmd\git.exe'

function Say  ($m) { Write-Host $m -ForegroundColor White }
function Ok   ($m) { Write-Host "OK   $m" -ForegroundColor Green }
function Warn ($m) { Write-Host "!!   $m" -ForegroundColor Yellow }
function Fail ($m) { Write-Host "XX   $m" -ForegroundColor Red; Read-Host 'Press Enter to close'; return }

# Refresh PATH from the registry so tools installed in THIS session (winget
# installs Docker/Git) become usable without a restart.
function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
              [Environment]::GetEnvironmentVariable('Path', 'User') + ';' +
              [Environment]::GetEnvironmentVariable('Path', 'Process')
}

# Locate the real docker.exe — command may not be on PATH yet after install.
# Returns the exe path or $null. Never throws.
function Find-Docker {
  $cmd = Get-Command docker -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  if (Test-Path $DockerCliPath) { return $DockerCliPath }
  return $null
}

# Locate git.exe — same story as docker.
function Find-Git {
  $cmd = Get-Command git -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  if (Test-Path $GitCliPath) { return $GitCliPath }
  return $null
}

# Run a docker command through whichever docker.exe we found.
function Invoke-Docker {
  param([Parameter(ValueFromRemainingArguments)] $Args)
  $exe = Find-Docker
  if (-not $exe) { throw 'docker not found' }
  & $exe @Args 2>&1
  return $LASTEXITCODE
}

$script:DockerExe = $null

Say ''
Say '════ Tailor CV installer ════'
Say ''

# ── 0. Administrator privileges ─────────────────────────────────────────────
# Installing Docker Desktop requires admin. winget will trigger the UAC prompt
# either way, but warn up-front so the "click Yes" moment isn't a surprise.
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($isAdmin) {
  Ok 'Running with administrator rights'
} else {
  Warn 'Not running as administrator — Windows will ask for permission when Docker installs. Click Yes.'
  Warn 'Tip: for the smoothest install, right-click this window → "Run as administrator" and rerun.'
}

# ── 1. Already running? ─────────────────────────────────────────────────────
try {
  $probe = Invoke-WebRequest -Uri $AppUrl -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
  if ($probe.StatusCode -eq 200) {
    Warn "Tailor CV is already running at $AppUrl."
    Say 'To UPDATE to the latest version, paste this instead:'
    Say ''
    Say '  irm https://raw.githubusercontent.com/Atanub707/Tailor-AI/main/scripts/update.ps1 | iex'
    Say ''
    Start-Process $AppUrl
    Read-Host 'Press Enter to close'
    return
  }
} catch { }

# ── 1. Docker CLI ───────────────────────────────────────────────────────────
$script:DockerExe = Find-Docker
if ($script:DockerExe) {
  Ok 'Docker CLI found'
} else {
  Say 'Docker not found — installing Docker Desktop (one UAC prompt will appear, click Yes).'
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Fail 'winget is missing. Update Windows 10/11, or install Docker Desktop manually from https://www.docker.com/products/docker-desktop/'
  }

  # Pending reboot is the #1 silent killer of Windows installers (exit -6).
  $pending = Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager' -Name PendingFileRenameOperations -ErrorAction SilentlyContinue
  if ($pending) {
    Fail 'Windows has a pending reboot. Restart your PC first, then run the installer again — it will continue from here.'
  }

  # Attempt 1: winget (may need elevation)
  winget install -e --id Docker.DockerDesktop --accept-source-agreements --accept-package-agreements | Out-Null
  if ($LASTEXITCODE -ne 0) {
    # Attempt 2: same, but explicitly elevated (UAC prompt)
    Warn "winget install failed (exit $LASTEXITCODE) — retrying as administrator…"
    Start-Process winget -ArgumentList 'install','-e','--id','Docker.DockerDesktop','--accept-source-agreements','--accept-package-agreements' -Verb RunAs -Wait
    if ($LASTEXITCODE -ne 0) {
      # Attempt 3: the official Docker installer, silent + elevated
      Warn 'Still failing — trying the official Docker Desktop installer directly…'
      $installer = Join-Path $env:TEMP 'DockerDesktopInstaller.exe'
      try {
        Invoke-WebRequest -Uri 'https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe' -OutFile $installer -UseBasicParsing -ErrorAction Stop
        Start-Process -FilePath $installer -ArgumentList 'install','--quiet','--accept-license','--accept-default-answers' -Verb RunAs -Wait
      } catch {
        $LASTEXITCODE = 1
      }
    }
  }
  if ($LASTEXITCODE -ne 0) {
    Fail 'Could not install Docker Desktop automatically. Install it manually from https://www.docker.com/products/docker-desktop/ (click Yes on the prompt), then rerun this installer.'
  }

  # Refresh PATH — docker.exe was installed this session and is NOT on PATH yet.
  Refresh-Path
  $script:DockerExe = Find-Docker
  if (-not $script:DockerExe) {
    Fail 'Docker was installed but docker.exe is not on your PATH yet. Log out and back in (or restart), then run the installer again — it will continue from here.'
  }
  Ok "Docker CLI found at $script:DockerExe"

  # First-time machines: WSL2 itself may be missing.
  wsl --status 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Warn 'WSL2 is missing — installing it now (this may take a few minutes).'
    wsl --install --no-distribution | Out-Host
    Fail 'WSL2 was installed. Restart your PC, then run the installer again — it will skip straight to starting the app.'
  }
  Ok 'Docker Desktop installed'
}

# ── 2. Start Docker Desktop EXPLICITLY ──────────────────────────────────────
# Installing Docker Desktop does NOT start the engine. Launch it by its full
# path so the Linux engine (dockerDesktopLinuxEngine pipe) actually comes up.
# NOTE: never let Docker's stderr become a fatal error (PowerShell 7 turns
# native stderr into a terminating error under ErrorActionPreference=Stop) —
# always check $LASTEXITCODE instead.
function Test-DockerEngine {
  $exe = Find-Docker
  if (-not $exe) { return $false }
  & $exe info 2>&1 | Out-Null
  return ($LASTEXITCODE -eq 0)
}

if (-not (Test-Path $DockerDesktopExe)) { $DockerDesktopExe = 'Docker Desktop' }
$engineReady = $false
if (Test-DockerEngine) {
  $engineReady = $true
} else {
  Say 'Starting Docker Desktop…'
  try { Start-Process $DockerDesktopExe } catch { Warn 'Could not launch Docker Desktop — please start it manually from the Start menu.' }

  # ── 3. WAIT for the engine (not just the CLI) ─────────────────────────────
  # First launch: Docker service → WSL2 init → Linux VM → engine → named pipe.
  # This can take 1–3 minutes. Poll every 2s (90 attempts).
  Say 'Waiting for the Docker engine to be ready (first launch can take a few minutes)…'
  $wslChecked = $false
  for ($i = 1; $i -le 90; $i++) {
    if (Test-DockerEngine) { $engineReady = $true; break }
    if ($i % 10 -eq 0) { Say "  still waiting… attempt $i/90" }
    # "Docker Desktop is unable to start" often means WSL2 is missing on
    # machines where Docker was installed before WSL. Check + fix once.
    if ($i -eq 15 -and -not $wslChecked) {
      $wslChecked = $true
      wsl --status 2>&1 | Out-Null
      if ($LASTEXITCODE -ne 0) {
        Warn 'WSL2 missing — installing it (Docker needs it). May need a restart after this.'
        wsl --install --no-distribution | Out-Host
      }
    }
    Start-Sleep -Seconds 2
  }
}

if (-not $engineReady) {
  Fail 'The Docker engine did not become ready. Open Docker Desktop once, accept any first-run prompts (or restart your PC if WSL2 was just installed), then run the installer again.'
}
Ok 'Docker engine is ready'

# ── 4. Verify compose v2 (bundled with Docker Desktop) ──────────────────────
& (Find-Docker) compose version 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { Fail 'docker compose v2 is missing — update Docker Desktop.' }
Ok 'docker compose v2 found'

# ── 5. Get the app ──────────────────────────────────────────────────────────
if (-not (Test-Path (Join-Path $AppDir 'docker-compose.yml'))) {
  # A folder exists but the app isn't there → it's a stale/partial install
  # (e.g. a failed clone, a leftover .git, or junk from an aborted run).
  # git clone refuses to clone into a non-empty directory, so clean it first
  # while PRESERVING config.ini (API keys) if the user already set them up.
  if (Test-Path $AppDir) {
    Warn "A previous incomplete install was found at $AppDir — cleaning it up before downloading fresh."
    $cfgKeep = Join-Path $AppDir 'config.ini'
    $cfgBackup = Join-Path $env:TEMP 'tailor-cv-config.ini.bak'
    if ((Test-Path $cfgKeep) -and (-not (Get-Item $cfgKeep).PSIsContainer)) {
      Copy-Item $cfgKeep $cfgBackup -Force
      Warn 'Your existing config.ini (API keys) was backed up and will be restored.'
    }
    Remove-Item $AppDir -Recurse -Force
  }

  Say "Downloading Tailor CV to $AppDir"
  $gitExe = Find-Git
  if (-not $gitExe) {
    Warn 'git not found — installing it via winget.'
    if (Get-Command winget -ErrorAction SilentlyContinue) {
      winget install -e --id Git.Git --accept-source-agreements --accept-package-agreements | Out-Null
      if ($LASTEXITCODE -ne 0) {
        Warn "winget git install failed (exit $LASTEXITCODE) — retrying as administrator…"
        Start-Process winget -ArgumentList 'install','-e','--id','Git.Git','--accept-source-agreements','--accept-package-agreements' -Verb RunAs -Wait
      }
    } else {
      Warn 'winget is missing — please install git manually from https://git-scm.com/download/win'
    }
    # Refresh PATH — git was installed this session and is NOT on PATH yet.
    Refresh-Path
    $gitExe = Find-Git
    if (-not $gitExe) {
      Fail 'git is required but was not found after install. Install git from https://git-scm.com/download/win, then rerun this installer.'
    }
  }
  New-Item -ItemType Directory -Force -Path $AppDir | Out-Null
  & $gitExe clone --depth 1 $RepoUrl $AppDir
  if ($LASTEXITCODE -ne 0) { Fail 'Could not download the app. Check your connection, or clone the repo manually.' }
  Ok 'App downloaded'
}

# Restore a backed-up config.ini (from the stale-folder cleanup above) so the
# user's API keys are not lost.
$cfgBackup = Join-Path $env:TEMP 'tailor-cv-config.ini.bak'
$cfgPath2 = Join-Path $AppDir 'config.ini'
if ((Test-Path $cfgBackup) -and (-not (Test-Path $cfgPath2))) {
  Copy-Item $cfgBackup $cfgPath2 -Force
  Remove-Item $cfgBackup -Force
  Ok 'Restored your previous config.ini (API keys kept intact)'
}

# ── 6. Prepare config.ini ───────────────────────────────────────────────────
# Create an EMPTY config.ini BEFORE compose up — otherwise Docker bind-mounts
# the missing file as a directory and token saves silently fail later.
$cfgPath = Join-Path $AppDir 'config.ini'
if (Test-Path $cfgPath) {
  $cfgItem = Get-Item $cfgPath
  if ($cfgItem.PSIsContainer) { Remove-Item $cfgPath -Force }  # Docker mount artifact
}
if (-not (Test-Path $cfgPath)) {
  New-Item -ItemType File -Path $cfgPath -Force | Out-Null
}

# ── 7. Run ──────────────────────────────────────────────────────────────────
Say 'Starting Tailor CV…'
& (Find-Docker) compose -f (Join-Path $AppDir 'docker-compose.yml') up -d --pull missing
if ($LASTEXITCODE -ne 0) { Fail 'docker compose failed — see the output above.' }
Ok 'Tailor CV container started'

# ── 7. Verify the app is healthy ────────────────────────────────────────────
Say 'Verifying the app…'
$healthy = $false
for ($i = 1; $i -le 30; $i++) {
  try {
    $check = Invoke-WebRequest -Uri $AppUrl -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
    if ($check.StatusCode -eq 200) { $healthy = $true; break }
  } catch { }
  Start-Sleep -Seconds 2
}
if ($healthy) { Ok 'Tailor CV is running and healthy' } else { Warn 'The app started, but is still warming up — open the URL below in a moment.' }

Start-Process $AppUrl

Say ''
Say '──────────────────────────────────────────────'
Say "Done! Tailor CV is ready at $AppUrl"
Say '  Sign in or continue as guest, then set your AI key:'
Say '  top-right menu -> Settings -> Integrations -> LLM & AI'
Say "  Stop it:     docker compose -f $(Join-Path $AppDir 'docker-compose.yml') down"
Say '  Update:      re-run this installer (it skips finished steps)'
Say '  Uninstall:   stop Docker Desktop and delete the tailor-cv folder'
Say '──────────────────────────────────────────────'
Say ''
