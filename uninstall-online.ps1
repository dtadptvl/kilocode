$ErrorActionPreference = 'Stop'
$Raw = 'https://raw.githubusercontent.com/dtadptvl/kilocode-zero-mem/main'
$script = Join-Path $env:TEMP 'kilo-zero-mem-uninstall.ps1'
Invoke-WebRequest -UseBasicParsing -Uri "$Raw/uninstall.ps1" -OutFile $script
& powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File $script
$code = $LASTEXITCODE
Remove-Item -Force -ErrorAction SilentlyContinue $script
exit $code
