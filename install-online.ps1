$ErrorActionPreference = 'Stop'

$Repo = 'dtadptvl/kilocode-zero-mem'
$Ref = 'main'
$Raw = "https://raw.githubusercontent.com/$Repo/$Ref"

if (-not (Get-Command kilo -ErrorAction SilentlyContinue)) {
  throw 'Kilo Code CLI not found in PATH.'
}

$paths = (& kilo debug paths | Out-String)
if ($LASTEXITCODE -ne 0) {
  throw 'kilo debug paths failed.'
}

$line = @($paths -split "`r?`n") |
  Where-Object { $_ -match '^\s*config\s+(.+?)\s*$' } |
  Select-Object -First 1

if (-not $line -or $line -notmatch '^\s*config\s+(.+?)\s*$') {
  throw 'Could not resolve Kilo config directory.'
}

$configRoot = [IO.Path]::GetFullPath($Matches[1])
$pluginRoot = Join-Path $configRoot 'zero-mem'
$srcRoot = Join-Path $pluginRoot 'src'

New-Item -ItemType Directory -Force -Path $srcRoot | Out-Null

$files = @(
  @{ Remote = 'package.json'; Local = (Join-Path $pluginRoot 'package.json') },
  @{ Remote = 'src/core.ts'; Local = (Join-Path $srcRoot 'core.ts') },
  @{ Remote = 'src/index.ts'; Local = (Join-Path $srcRoot 'index.ts') }
)

foreach ($file in $files) {
  $url = "$Raw/$($file.Remote)"
  Write-Host "Downloading $($file.Remote)..."
  Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $file.Local
}

$spec = 'file://' + (($pluginRoot -replace '\\','/'))

Write-Host 'Registering Zero-Mem globally with Kilo...'
& kilo plugin $spec --global --force
if ($LASTEXITCODE -ne 0) {
  throw "kilo plugin registration failed with exit code $LASTEXITCODE"
}

Write-Host ''
Write-Host 'PASS: Zero-Mem installed and registered globally.' -ForegroundColor Green
Write-Host "Plugin directory: $pluginRoot"
Write-Host 'Restart Kilo Code CLI to load the plugin.'
Write-Host 'Optional zero-generative Project Memory mode: run /memory auto off inside Kilo.'
