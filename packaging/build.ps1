<#
.SYNOPSIS
  Builds dist\ZHU-Setup.exe: frozen Python engine + React front end + Tauri shell, packaged with NSIS.

.DESCRIPTION
  Steps
    1. Create or refresh the engine virtualenv (Python 3.12+), including the CUDA runtime wheels.
    2. Run the engine test suite (aborts the build on failure).
    3. Freeze the engine with PyInstaller (one folder) into build\zhu-engine.
    4. Install front-end dependencies, run the front-end tests, and build the Tauri app with NSIS.
    5. Copy the installer to dist\ZHU-Setup.exe and write a SHA-256 checksum file.

  Speech models are NOT bundled. On first launch ZHU offers a one-time download into
  %LOCALAPPDATA%\app.zhu.desktop\data\models. Later launches detect the installed model and skip the setup screen.

.PARAMETER SkipTests  Skip the engine and front-end test suites.
.PARAMETER Sign       Code-sign the installer with signtool (requires ZHU_SIGN_CERT_THUMBPRINT).
#>
param([switch]$SkipTests, [switch]$Sign)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Engine = Join-Path $Root 'engine'
$Desktop = Join-Path $Root 'apps\desktop'
$Build = Join-Path $Root 'build'
$Dist = Join-Path $Root 'dist'
$Py = Join-Path $Engine '.venv\Scripts\python.exe'

function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Check($code, $what) { if ($code -ne 0) { throw "$what failed (exit code $code)" } }

Step 'Engine virtualenv'
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

Step 'Front end + Tauri (NSIS)'
Push-Location $Desktop
try {
  npm ci; Check $LASTEXITCODE 'npm ci'
  if (-not $SkipTests) { npm test; Check $LASTEXITCODE 'front-end tests' }
  $env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
  # Bounded parallelism keeps rustc and Node within RAM on 16 GB machines (measured: unbounded builds failed).
  if (-not $env:CARGO_BUILD_JOBS) { $env:CARGO_BUILD_JOBS = '2' }
  if (-not $env:NODE_OPTIONS) { $env:NODE_OPTIONS = '--max-old-space-size=2048' }
  npx tauri build --config src-tauri/tauri.bundle.conf.json; Check $LASTEXITCODE 'tauri build'
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
Write-Host "`nBuilt $out ($([math]::Round((Get-Item $out).Length / 1MB)) MB)`nSHA-256 $hash" -ForegroundColor Green
