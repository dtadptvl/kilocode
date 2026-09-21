param(
  [string]$SourceRoot = $PSScriptRoot
)

$ErrorActionPreference = 'Stop'

function Resolve-KiloConfig {
  if (-not (Get-Command kilo -ErrorAction SilentlyContinue)) {
    throw 'Kilo Code CLI not found in PATH.'
  }

  $paths = (& kilo debug paths | Out-String)
  if ($LASTEXITCODE -ne 0) { throw 'kilo debug paths failed.' }

  $line = @($paths -split "`r?`n") |
    Where-Object { $_ -match '^\s*config\s+(.+?)\s*$' } |
    Select-Object -First 1

  if (-not $line -or $line -notmatch '^\s*config\s+(.+?)\s*$') {
    throw 'Could not resolve Kilo config directory.'
  }
  return [IO.Path]::GetFullPath($Matches[1])
}

function Validate-Stage([string]$Stage) {
  foreach ($file in @('package.json', 'src\core.ts', 'src\index.ts', 'src\store.ts', 'src\kilo.ts')) {
    $path = Join-Path $Stage $file
    if (-not (Test-Path -LiteralPath $path) -or (Get-Item -LiteralPath $path).Length -eq 0) {
      throw "Invalid Zero-Mem package: missing or empty $file"
    }
  }

  $manifest = Get-Content -Raw -LiteralPath (Join-Path $Stage 'package.json') | ConvertFrom-Json
  if ($manifest.name -ne 'kilo-zero-mem') { throw 'Invalid Zero-Mem package name.' }
  if (-not $manifest.version) { throw 'Invalid Zero-Mem package version.' }
  if (-not $manifest.exports.'./server'.import) { throw 'Invalid Zero-Mem server export.' }
  return [string]$manifest.version
}

$configRoot = Resolve-KiloConfig
$pluginRoot = Join-Path $configRoot 'zero-mem'
$stageRoot = Join-Path $configRoot ('.zero-mem-stage-' + $PID + '-' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
$rollbackRoot = Join-Path $configRoot '.zero-mem-rollback'

try {
  New-Item -ItemType Directory -Force -Path (Join-Path $stageRoot 'src') | Out-Null
  Copy-Item -Force -LiteralPath (Join-Path $SourceRoot 'package.json') -Destination (Join-Path $stageRoot 'package.json')
  foreach ($file in @('core.ts', 'index.ts', 'store.ts', 'kilo.ts')) {
    Copy-Item -Force -LiteralPath (Join-Path $SourceRoot "src\$file") -Destination (Join-Path $stageRoot "src\$file")
  }

  $version = Validate-Stage $stageRoot

  $oldIndex = Join-Path $pluginRoot 'zero-mem-index-v1.json'
  if (Test-Path -LiteralPath $oldIndex) {
    Copy-Item -Force -LiteralPath $oldIndex -Destination (Join-Path $stageRoot 'zero-mem-index-v1.json')
  }

  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue -LiteralPath $rollbackRoot
  $hadPrevious = Test-Path -LiteralPath $pluginRoot
  if ($hadPrevious) { Move-Item -LiteralPath $pluginRoot -Destination $rollbackRoot }

  try {
    Move-Item -LiteralPath $stageRoot -Destination $pluginRoot
    $spec = 'file://' + (($pluginRoot -replace '\\','/'))
    & kilo plugin $spec --global --force
    if ($LASTEXITCODE -ne 0) {
      throw "kilo plugin registration failed with exit code $LASTEXITCODE"
    }
  } catch {
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue -LiteralPath $pluginRoot
    if ($hadPrevious -and (Test-Path -LiteralPath $rollbackRoot)) {
      Move-Item -LiteralPath $rollbackRoot -Destination $pluginRoot
    }
    throw
  }

  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue -LiteralPath $rollbackRoot
  Write-Host ''
  Write-Host "PASS: Zero-Mem $version installed and registered globally." -ForegroundColor Green
  Write-Host "Plugin directory: $pluginRoot"
  Write-Host 'Restart Kilo Code CLI to load the plugin.'
} finally {
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue -LiteralPath $stageRoot
}
