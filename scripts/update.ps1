# Tailor CV — updater (Windows). Launched by update.bat.
# NEVER use Stop: PowerShell 7.3+ makes native stderr (e.g. Docker's error
# output) a TERMINATING error under Stop — killing the installer before the
# engine wait loop runs. We check $LASTEXITCODE explicitly everywhere instead.
$ErrorActionPreference = 'Continue'
$PSNativeCommandUseErrorActionPreference = $false
$AppDir = Join-Path $env:USERPROFILE 'tailor-cv'
$AppUrl = 'http://localhost:3000'

function Say  ($m) { Write-Host $m -ForegroundColor White }
function Ok   ($m) { Write-Host "OK   $m" -ForegroundColor Green }
function Fail ($m) { Write-Host "XX   $m" -ForegroundColor Red; Read-Host 'Press Enter to close'; exit 1 }

# Refresh PATH — the terminal that runs this script may predate a git/docker
# install (or the installer ran in another window), so the commands are not
# always on PATH here.
function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
              [Environment]::GetEnvironmentVariable('Path', 'User') + ';' +
              [Environment]::GetEnvironmentVariable('Path', 'Process')
}

function Find-Git {
  $cmd = Get-Command git -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $candidates = @(
    "$env:ProgramFiles\Git\cmd\git.exe",
    "${env:ProgramFiles(x86)}\Git\cmd\git.exe",
    "$env:LOCALAPPDATA\Programs\Git\cmd\git.exe"
  )
  foreach ($p in $candidates) { if (Test-Path $p) { return $p } }
  return $null
}

function Find-Docker {
  $cmd = Get-Command docker -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $candidates = @(
    "$env:ProgramFiles\Docker\Docker\resources\bin\docker.exe",
    "$env:LOCALAPPDATA\Docker\cli-plugins\docker.exe"
  )
  foreach ($p in $candidates) { if (Test-Path $p) { return $p } }
  return $null
}

Refresh-Path
$gitExe = Find-Git
if (-not $gitExe) { Fail 'git is required for updates but was not found. Install git from https://git-scm.com/download/win, then rerun this updater.' }
$dockerExe = Find-Docker
if (-not $dockerExe) { Fail 'Docker is not installed — run the installer first.' }

Say ''
Say '════ Tailor CV updater ════'
Say ''

if (-not (Test-Path (Join-Path $AppDir '.git'))) { Fail "No Tailor CV install found at $AppDir — run the installer first." }

Say 'Pulling the latest code…'
& $gitExe -C $AppDir pull --ff-only
if ($LASTEXITCODE -ne 0) { Fail 'Could not pull the update — check your connection.' }
Ok 'Code updated'

# Make sure the Docker engine is actually ready before compose (first
# launch / after a reboot the engine needs time to come up).
# NOTE: check $LASTEXITCODE — native stderr is fatal under Stop in PS7.
function Test-DockerEngine {
  & $dockerExe info 2>&1 | Out-Null
  return ($LASTEXITCODE -eq 0)
}
$engineReady = $false
for ($i = 1; $i -le 60; $i++) {
  if (Test-DockerEngine) { $engineReady = $true; break }
  Start-Sleep -Seconds 2
}
if (-not $engineReady) { Fail 'The Docker engine did not become ready. Open Docker Desktop once, then run update.bat again.' }
Ok 'Docker engine ready'

$cfgPath = Join-Path $AppDir 'config.ini'
if (Test-Path $cfgPath) {
  $cfgItem = Get-Item $cfgPath
  if ($cfgItem.PSIsContainer) { Remove-Item $cfgPath -Force }  # Docker mount artifact
}
if (-not (Test-Path $cfgPath)) {
  New-Item -ItemType File -Path $cfgPath -Force | Out-Null
}

Say 'Refreshing the app…'
& $dockerExe compose -f (Join-Path $AppDir 'docker-compose.yml') up -d --build --pull missing
if ($LASTEXITCODE -ne 0) { Fail 'docker compose failed — see the output above.' }
Ok 'Tailor CV updated and running'

Start-Sleep -Seconds 2
Start-Process $AppUrl
Say ''
Say "Done! The app is at $AppUrl"
Say ''
