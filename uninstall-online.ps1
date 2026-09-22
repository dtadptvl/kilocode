param(
  [string]$Ref = '842257d3efc501b0d4fe17d75a34d0d830dff60c'
)

$ErrorActionPreference = 'Stop'
$Raw = "https://raw.githubusercontent.com/dtadptvl/kilocode-zero-mem/$Ref"
$script = Join-Path $env:TEMP ('kilo-zero-mem-uninstall-' + $PID + '.ps1')

try {
  Invoke-WebRequest -UseBasicParsing -Uri "$Raw/uninstall.ps1" -OutFile $script
  & powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File $script
  if ($LASTEXITCODE -ne 0) { throw "Zero-Mem uninstaller failed with exit code $LASTEXITCODE" }
} finally {
  Remove-Item -Force -ErrorAction SilentlyContinue $script
}
