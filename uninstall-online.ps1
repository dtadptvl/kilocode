param(
  [string]$Ref = '8eba2315ac5054c97e3536ec62d4395da7ea5cc9'
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
