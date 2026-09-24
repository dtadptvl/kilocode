param(
  [string]$Ref = '4f499ba848d8db5e4439b714a2a9fbc14d3d792d'
)

$ErrorActionPreference = 'Stop'
$Repo = 'dtadptvl/kilocode-zero-mem'
$Raw = "https://raw.githubusercontent.com/$Repo/$Ref"
$stage = Join-Path $env:TEMP ('kilo-zero-mem-download-' + $PID + '-' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())

try {
  New-Item -ItemType Directory -Force -Path (Join-Path $stage 'src') | Out-Null

  $files = @(
    'install.ps1',
    'package.json',
    'src/core.ts',
    'src/index.ts',
    'src/store.ts',
    'src/kilo.ts'
  )

  foreach ($file in $files) {
    $target = Join-Path $stage ($file -replace '/', '\')
    $parent = Split-Path -Parent $target
    if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    Write-Host "Downloading $file from $Ref..."
    Invoke-WebRequest -UseBasicParsing -Uri "$Raw/$file" -OutFile $target
  }

  & powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $stage 'install.ps1') -SourceRoot $stage
  if ($LASTEXITCODE -ne 0) { throw "Zero-Mem installer failed with exit code $LASTEXITCODE" }
} finally {
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue -LiteralPath $stage
}
