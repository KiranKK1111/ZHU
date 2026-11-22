<#
.SYNOPSIS
  Works out ZHU's next version from the commits since the last release, and writes a version
  into every file that carries one.

.DESCRIPTION
  Released versions are git tags (v1.4.2). The next version follows from what was committed
  since the last tag, read from the first line of each commit message:

    main version (1.4.2 -> 2.0.0)   a change that breaks something people rely on:
                                    "feat!: ...", "fix(api)!: ...", a line "BREAKING CHANGE: ..."
                                    in the message, or a message starting with "major:" / "breaking:"
    sub version  (1.4.2 -> 1.5.0)   a new feature: "feat: ..." / "feature: ...", or a message
                                    starting with Add, Implement, Introduce, New, Support, Enable,
                                    Allow or Create
    patch        (1.4.2 -> 1.4.3)   everything else: fixes, clean-ups, wording, build changes

  The largest change among the commits decides. With no tag yet, the first release takes the
  version that is in the files (apps/desktop/src-tauri/tauri.conf.json).

  Without parameters the script only reports. Nothing is committed or tagged by it: the release
  workflow (.github/workflows/release.yml) calls it, builds, and creates the tag.

.PARAMETER Apply     Work out the next version and write it into the files.
.PARAMETER Set       Write this version into the files ("1.5.0" or "v1.5.0").
.PARAMETER Root      The repository (default: the folder above this script).
.PARAMETER Messages  For tests: commit messages to judge, instead of the ones git has.
.PARAMETER Base      For tests: the last released version, instead of git's last tag.

.EXAMPLE
  packaging\version.ps1                 # what would the next version be, and why?
.EXAMPLE
  packaging\version.ps1 -Set 1.0.0      # write 1.0.0 into all version files
#>
param(
  [switch]$Apply,
  [string]$Set,
  [string]$Root = (Split-Path -Parent $PSScriptRoot),
  [string[]]$Messages,
  [string]$Base
)

$ErrorActionPreference = 'Stop'
$SemVer = '^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$'

function Get-Bump([string]$message) {
  $subject = ($message -split "`r?`n")[0].Trim()
  if ($subject -match '^[a-z]+(\([^)]*\))?!:' -or $subject -match '^(major|breaking)\b' -or $message -match '(?m)^BREAKING[ -]CHANGE') { return 'major' }
  if ($subject -match '^feat(ure)?(\([^)]*\))?:' -or $subject -match '^(add|adds|added|implement|implements|implemented|introduce|introduces|introduced|new|support|supports|enable|enables|allow|allows|create|creates|created)\b') { return 'minor' }
  return 'patch'
}

function Step-Version([string]$version, [string]$bump) {
  if ($version -notmatch $SemVer) { throw "'$version' is not a version like 1.4.2" }
  $major = [int]$Matches[1]; $minor = [int]$Matches[2]; $patch = [int]$Matches[3]
  switch ($bump) {
    'major' { return "$($major + 1).0.0" }
    'minor' { return "$major.$($minor + 1).0" }
    'patch' { return "$major.$minor.$($patch + 1)" }
    default { return "$major.$minor.$patch" }
  }
}

# Replace the first `count` matches of a pattern in a file. The file keeps its line endings and
# is written as UTF-8 without a byte-order mark (which some of these files' readers reject).
function Edit-File([string]$relative, [string]$pattern, [string]$replacement, [int]$count = 1) {
  $path = Join-Path $Root $relative
  $text = [System.IO.File]::ReadAllText($path)
  $regex = New-Object System.Text.RegularExpressions.Regex($pattern, [System.Text.RegularExpressions.RegexOptions]::Multiline)
  if ($regex.Matches($text).Count -lt $count) { throw "$relative no longer has its version where it is expected (pattern: $pattern)" }
  [System.IO.File]::WriteAllText($path, $regex.Replace($text, $replacement, $count), (New-Object System.Text.UTF8Encoding $false))
}

function Write-Version([string]$version) {
  if ($version -notmatch $SemVer) { throw "'$version' is not a version like 1.4.2" }
  $numbers = "$($Matches[1]), $($Matches[2]), $($Matches[3]), 0"   # Windows file versions are four numbers
  $quoted = '${1}' + $version + '${2}'
  $json = '("version"\s*:\s*")[^"]*(")'
  $toml = '^(version\s*=\s*")[^"]*(")'
  $sep = [System.IO.Path]::DirectorySeparatorChar
  $in = { param($p) $p -replace '/', $sep }
  Edit-File (& $in 'apps/desktop/src-tauri/tauri.conf.json') $json $quoted
  Edit-File (& $in 'apps/desktop/src-tauri/Cargo.toml') $toml $quoted
  Edit-File (& $in 'apps/desktop/src-tauri/Cargo.lock') '(name = "zhu"\r?\nversion = ")[^"]*(")' $quoted
  Edit-File (& $in 'apps/desktop/package.json') $json $quoted
  Edit-File (& $in 'apps/desktop/package-lock.json') $json $quoted 2      # the package itself, twice at the top
  Edit-File (& $in 'engine/pyproject.toml') $toml $quoted
  Edit-File (& $in 'engine/zhu_engine/__init__.py') '^(__version__\s*=\s*")[^"]*(")' $quoted
  Edit-File (& $in 'packaging/engine_version.txt') '(filevers=\()[^)]*(\))' ('${1}' + $numbers + '${2}')
  Edit-File (& $in 'packaging/engine_version.txt') '(prodvers=\()[^)]*(\))' ('${1}' + $numbers + '${2}')
  Edit-File (& $in 'packaging/engine_version.txt') "(StringStruct\('FileVersion', ')[^']*(')" $quoted
  Edit-File (& $in 'packaging/engine_version.txt') "(StringStruct\('ProductVersion', ')[^']*(')" $quoted
}

function Get-FileVersion {
  $text = [System.IO.File]::ReadAllText((Join-Path $Root (Join-Path 'apps' (Join-Path 'desktop' (Join-Path 'src-tauri' 'tauri.conf.json')))))
  if ($text -notmatch '"version"\s*:\s*"([^"]+)"') { throw 'tauri.conf.json has no version' }
  return $Matches[1]
}

# ---- an explicit version -------------------------------------------------------------------
if ($Set) {
  $version = $Set.Trim() -replace '^v', ''
  Write-Version $version
  $result = [ordered]@{ version = $version; previous = ''; bump = 'set'; commits = 0 }
}
# ---- the next version, from the commits since the last release -----------------------------
else {
  $previous = $Base
  $commits = $Messages
  if (-not $PSBoundParameters.ContainsKey('Messages')) {
    if (-not $previous) {
      # The highest version tag among this commit's ancestors (nothing is printed when there is none).
      $tag = @(& git -C $Root tag --list 'v[0-9]*' --merged HEAD --sort=-v:refname) | Select-Object -First 1
      if ($LASTEXITCODE -ne 0) { throw 'git tag failed' }
      if ($tag) { $previous = ("$tag".Trim() -replace '^v', '') }
    }
    $range = if ($previous) { "v$previous..HEAD" } else { 'HEAD' }
    $log = (& git -C $Root log $range '--format=%B%x1e') -join "`n"
    if ($LASTEXITCODE -ne 0) { throw "git log $range failed" }
    $commits = @($log -split [char]0x1e | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  }
  $commits = @($commits)

  if (-not $previous) {
    # Nothing released yet: the version in the files is the first one.
    $version = Get-FileVersion; $bump = 'first'
  } elseif ($commits.Count -eq 0) {
    $version = $previous; $bump = 'none'
  } else {
    $rank = @{ patch = 1; minor = 2; major = 3 }
    $bump = 'patch'
    foreach ($message in $commits) { $b = Get-Bump $message; if ($rank[$b] -gt $rank[$bump]) { $bump = $b } }
    $version = Step-Version $previous $bump
  }
  if ($Apply) { Write-Version $version }
  $result = [ordered]@{ version = $version; previous = "$previous"; bump = $bump; commits = $commits.Count }
}

# For the workflow: the same facts as step outputs.
if ($env:GITHUB_OUTPUT) { $result.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" } | Add-Content -Path $env:GITHUB_OUTPUT -Encoding utf8 }

$why = switch ($result.bump) {
  'set'   { 'set by hand' }
  'first' { 'first release: the version in the files' }
  'none'  { "nothing was committed since v$($result.previous)" }
  'major' { "after v$($result.previous): a breaking change among $($result.commits) commit(s)" }
  'minor' { "after v$($result.previous): a new feature among $($result.commits) commit(s)" }
  default { "after v$($result.previous): fixes and small changes in $($result.commits) commit(s)" }
}
$written = if ($Set -or $Apply) { ' (written into the version files)' } else { '' }
Write-Output "version $($result.version): $why$written"
