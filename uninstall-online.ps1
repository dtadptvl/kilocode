param(
  [string]$Ref = '4f499ba848d8db5e4439b714a2a9fbc14d3d792d'
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
