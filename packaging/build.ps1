<#
.SYNOPSIS
  Builds dist\ZHU-Setup.exe: frozen Python engine + React front end + Tauri shell, packaged with NSIS.

.DESCRIPTION
  Steps
    1. Create or refresh the engine virtualenv (Python 3.12+), including the CUDA runtime wheels.
    2. Run the engine test suite (aborts the build on failure).
    3. Freeze the engine with PyInstaller (one folder) into build\zhu-engine, and smoke-test it.
    4. Pack the NVIDIA libraries (pack_cuda.py): compressed once and kept in build\cuda-pack; the
       installer is made from build\stage\zhu-engine, which holds them compressed.
    5. Install front-end dependencies, run the front-end tests, and build the Tauri app with NSIS.
    6. Run the frozen engine inside a process the way the app does (examples/embedded_check.rs).
    7. Copy the installer to dist\ZHU-Setup.exe and write a SHA-256 checksum file.

  Speech models are NOT bundled. On first launch ZHU offers a one-time download into
  %LOCALAPPDATA%\app.zhu.desktop\data\models. Later launches detect the installed model and skip the setup screen.

.PARAMETER SkipTests    Skip the engine and front-end test suites.
.PARAMETER SkipInstall  Use the Python and npm packages that are already installed, instead of
                        installing them again. For a second build on the same computer; it also
                        works while "npm run tauri dev" is running, which the installs do not.
.PARAMETER Compression  How the installer compresses what it carries. Most of that is the NVIDIA
                        libraries, which arrive compressed already (step 4), so the fast method
                        is the default: zlib. Measured on the development laptop: the Tauri and
                        NSIS step takes 1.5 minutes and the installer is 882 MB. lzma and bzip2
                        compress the remaining files a little further and spend minutes trying
                        to compress the NVIDIA libraries again; not measured in this layout.
.PARAMETER Sign         Code-sign the installer with signtool (requires ZHU_SIGN_CERT_THUMBPRINT).
#>
param([switch]$SkipTests, [switch]$SkipInstall, [ValidateSet('zlib', 'lzma', 'bzip2')][string]$Compression = 'zlib', [switch]$Sign)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Engine = Join-Path $Root 'engine'
$Desktop = Join-Path $Root 'apps\desktop'
$Build = Join-Path $Root 'build'
$Dist = Join-Path $Root 'dist'
$Py = Join-Path $Engine '.venv\Scripts\python.exe'

# Each step is announced with the time, and the time the step before it took, so a slow build
# shows where the time went (in the terminal, and in the log of a build on GitHub).
$script:Started = Get-Date
$script:StepName = $null
$script:StepStarted = $null
$script:Timings = @()
function Step($msg) {
  $now = Get-Date
  if ($script:StepName) { $script:Timings += [pscustomobject]@{ Step = $script:StepName; Seconds = [int]($now - $script:StepStarted).TotalSeconds } }
  $script:StepName = $msg; $script:StepStarted = $now
  Write-Host "`n==> $msg  [$($now.ToString('HH:mm:ss'))]" -ForegroundColor Cyan
}
function Check($code, $what) { if ($code -ne 0) { throw "$what failed (exit code $code)" } }

Step 'Engine virtualenv'
if ($SkipInstall) {
  if (-not (Test-Path $Py)) { throw "-SkipInstall needs the engine's virtualenv ($Py); run once without it" }
} else {
  if (-not (Test-Path $Py)) {
    & py -3 -m venv (Join-Path $Engine '.venv'); Check $LASTEXITCODE 'venv creation'
  }
  & $Py -m pip install --upgrade pip | Out-Null
  & $Py -m pip install -e "$Engine[dev,cuda]"; Check $LASTEXITCODE 'pip install'
  # faster-whisper depends on the CPU-only "onnxruntime" wheel. It installs into the same
  # "onnxruntime" package folder as onnxruntime-directml, so whichever wheel is installed last
  # wins. Remove the CPU wheel and reinstall the DirectML one (CPU + DirectML providers).
  & $Py -m pip uninstall -y onnxruntime | Out-Null
  & $Py -m pip install --force-reinstall --no-deps "onnxruntime-directml==1.24.4"; Check $LASTEXITCODE 'onnxruntime-directml install'
}
& $Py -c "import onnxruntime as o, sys; p = o.get_available_providers(); print('onnxruntime', o.__version__, p); sys.exit(0 if 'DmlExecutionProvider' in p else 1)"
Check $LASTEXITCODE 'DirectML provider check'

if (-not $SkipTests) {
  Step 'Engine tests'
  Push-Location $Engine; & $Py -m pytest -q; $code = $LASTEXITCODE; Pop-Location; Check $code 'engine tests'
}

Step 'Freeze engine (PyInstaller)'
if (Test-Path (Join-Path $Build 'zhu-engine')) { Remove-Item -Recurse -Force (Join-Path $Build 'zhu-engine') }
& (Join-Path $Engine '.venv\Scripts\pyinstaller.exe') (Join-Path $PSScriptRoot 'zhu-engine.spec') --distpath $Build --workpath (Join-Path $Build 'pyi') --noconfirm
Check $LASTEXITCODE 'PyInstaller'

Step 'Smoke-test frozen engine'
$env:ZHU_ENGINE_TOKEN = -join ((1..48) | ForEach-Object { '{0:x}' -f (Get-Random -Maximum 16) })
$env:ZHU_DATA_DIR = Join-Path $Build 'smoke-data'
$psi = New-Object System.Diagnostics.ProcessStartInfo (Join-Path $Build 'zhu-engine\zhu-engine.exe')
$psi.RedirectStandardOutput = $true; $psi.UseShellExecute = $false
$proc = [System.Diagnostics.Process]::Start($psi)
$ready = $false; $deadline = (Get-Date).AddSeconds(90)
while ((Get-Date) -lt $deadline -and -not $proc.HasExited) {
  $line = $proc.StandardOutput.ReadLine()
  if ($line -match 'ZHU_ENGINE_READY port=(\d+)') { $port = $Matches[1]; $ready = $true; break }
}
if (-not $ready) { if (-not $proc.HasExited) { $proc.Kill() }; throw 'frozen engine did not become ready' }
$health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/health" -Headers @{ Authorization = "Bearer $env:ZHU_ENGINE_TOKEN" }
$gpu = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/system/gpu" -Headers @{ Authorization = "Bearer $env:ZHU_ENGINE_TOKEN" }
$proc.Kill(); Remove-Item Env:ZHU_ENGINE_TOKEN, Env:ZHU_DATA_DIR
Write-Host "frozen engine OK: version $($health.version); CUDA available: $($gpu.cuda_available); GPU: $($gpu.device_name)"

# The six NVIDIA libraries are 1.5 GB of the engine and the same in every build. They are
# compressed once (kept in build\cuda-pack) and the installer is made from build\stage\zhu-engine,
# which holds them in that form; the engine unpacks them after installation. The step also runs
# the staged engine's unpack command on one of them and compares the result with the original.
Step 'Pack the NVIDIA libraries'
& $Py (Join-Path $PSScriptRoot 'pack_cuda.py'); Check $LASTEXITCODE 'packing the NVIDIA libraries'

Step 'Front-end packages and tests'
Push-Location $Desktop
try {
  if ($SkipInstall) {
    if (-not (Test-Path 'node_modules')) { throw '-SkipInstall needs apps\desktop\node_modules; run once without it' }
  } else {
    npm ci; Check $LASTEXITCODE 'npm ci'
  }
  if (-not $SkipTests) { npm test; Check $LASTEXITCODE 'front-end tests' }
  Step 'App and installer (Tauri, NSIS)'
  $env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
  # Bounded parallelism keeps rustc and Node within RAM on 16 GB machines (measured: unbounded builds failed).
  if (-not $env:CARGO_BUILD_JOBS) { $env:CARGO_BUILD_JOBS = '2' }
  if (-not $env:NODE_OPTIONS) { $env:NODE_OPTIONS = '--max-old-space-size=2048' }
  # The bundle settings (the frozen engine as a resource) plus the chosen compression, as one file.
  $bundle = Get-Content 'src-tauri/tauri.bundle.conf.json' -Raw | ConvertFrom-Json
  $bundle.bundle | Add-Member -NotePropertyName windows -NotePropertyValue @{ nsis = @{ compression = $Compression } } -Force
  $bundleFile = Join-Path $Build 'tauri.bundle.json'
  [System.IO.File]::WriteAllText($bundleFile, ($bundle | ConvertTo-Json -Depth 10), (New-Object System.Text.UTF8Encoding $false))
  npx tauri build --config $bundleFile; Check $LASTEXITCODE 'tauri build'

  # ZHU runs the engine inside its own process (src-tauri/src/embedded.rs). Do exactly that with
  # the engine just frozen: start it in a process, ask it, stop it, and the same once more. It uses
  # build\zhu-engine, whose NVIDIA libraries are unpacked, and leaves that folder as it is.
  Step 'Engine inside the app process'
  Push-Location 'src-tauri'
  try {
    $env:ZHU_LOG_LEVEL = 'WARNING'
    cargo run --release --quiet --example embedded_check -- $Build; Check $LASTEXITCODE 'the engine inside the app process'
  } finally { Remove-Item Env:ZHU_LOG_LEVEL -ErrorAction SilentlyContinue; Pop-Location }
} finally { Pop-Location }

Step 'Collect installer'
$nsis = Get-ChildItem (Join-Path $Desktop 'src-tauri\target\release\bundle\nsis') -Filter '*-setup.exe' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $nsis) { throw 'NSIS installer not found' }
New-Item -ItemType Directory -Force $Dist | Out-Null
$out = Join-Path $Dist 'ZHU-Setup.exe'
Copy-Item $nsis.FullName $out -Force
if ($Sign) {
  if (-not $env:ZHU_SIGN_CERT_THUMBPRINT) { throw 'set ZHU_SIGN_CERT_THUMBPRINT to sign' }
  & signtool sign /sha1 $env:ZHU_SIGN_CERT_THUMBPRINT /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 $out; Check $LASTEXITCODE 'signtool'
}
$hash = (Get-FileHash $out -Algorithm SHA256).Hash
"$hash  ZHU-Setup.exe" | Out-File -Encoding ascii (Join-Path $Dist 'ZHU-Setup.exe.sha256')
Step 'Done'
Write-Host "`nBuilt $out ($([math]::Round((Get-Item $out).Length / 1MB)) MB)`nSHA-256 $hash" -ForegroundColor Green
Write-Host "`nWhere the time went ($([int]((Get-Date) - $script:Started).TotalMinutes) min in all):"
$script:Timings | ForEach-Object { Write-Host ("  {0,5} s  {1}" -f $_.Seconds, $_.Step) }
