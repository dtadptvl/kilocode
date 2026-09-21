$ErrorActionPreference = 'Stop'

$RepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$root = Join-Path $env:TEMP ('zero-mem-smoke-' + $PID + '-' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
$fakeBin = Join-Path $root 'bin'
$config = Join-Path $root 'config'
New-Item -ItemType Directory -Force -Path $fakeBin, $config | Out-Null

try {
  $fakeKilo = Join-Path $fakeBin 'kilo.ps1'
  @'
param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Args)
$config = $env:ZERO_MEM_SMOKE_CONFIG
if ($Args.Count -ge 2 -and $Args[0] -eq 'debug' -and $Args[1] -eq 'paths') {
  Write-Output "config  $config"
  exit 0
}
if ($Args.Count -ge 2 -and $Args[0] -eq 'plugin') {
  if ($env:ZERO_MEM_SMOKE_FAIL_PLUGIN -eq '1') { exit 9 }
  $file = Join-Path $config 'opencode.json'
  if (Test-Path $file) { $data = Get-Content -Raw $file | ConvertFrom-Json } else { $data = [pscustomobject]@{} }
  if (-not $data.PSObject.Properties['plugin']) { $data | Add-Member -NotePropertyName plugin -NotePropertyValue @() }
  $spec = $Args[1]
  $data.plugin = @($data.plugin | Where-Object { $_ -ne $spec }) + $spec
  $data | ConvertTo-Json -Depth 10 | Set-Content -Encoding UTF8 $file
  exit 0
}
exit 1
'@ | Set-Content -Encoding UTF8 $fakeKilo

  $env:ZERO_MEM_SMOKE_CONFIG = $config
  $env:PATH = "$fakeBin;$env:PATH"

  & (Join-Path $RepoRoot 'install.ps1') -SourceRoot $RepoRoot
  if (-not (Test-Path (Join-Path $config 'zero-mem\src\index.ts'))) { throw 'install did not copy plugin source' }
  $cfg = Get-Content -Raw (Join-Path $config 'opencode.json')
  if ($cfg -notmatch 'zero-mem') { throw 'install did not register plugin' }

  & (Join-Path $RepoRoot 'uninstall.ps1')
  if (Test-Path (Join-Path $config 'zero-mem')) { throw 'uninstall did not remove plugin directory' }
  $cfg = Get-Content -Raw (Join-Path $config 'opencode.json')
  if ($cfg -match 'zero-mem') { throw 'uninstall did not remove plugin registration' }

  $pluginRoot = Join-Path $config 'zero-mem'
  New-Item -ItemType Directory -Force -Path $pluginRoot | Out-Null
  Set-Content -LiteralPath (Join-Path $pluginRoot 'old-marker.txt') -Value 'old-working-installation'
  $env:ZERO_MEM_SMOKE_FAIL_PLUGIN = '1'
  $failed = $false
  try {
    & (Join-Path $RepoRoot 'install.ps1') -SourceRoot $RepoRoot
  } catch {
    $failed = $true
  }
  if (-not $failed) { throw 'expected registration failure was not surfaced' }
  if (-not (Test-Path (Join-Path $pluginRoot 'old-marker.txt'))) { throw 'failed update did not rollback previous installation' }

  $global:LASTEXITCODE = 0
  Write-Host 'PASS Windows install/uninstall/rollback smoke'
} finally {
  Remove-Item Env:ZERO_MEM_SMOKE_FAIL_PLUGIN -ErrorAction SilentlyContinue
  Remove-Item Env:ZERO_MEM_SMOKE_CONFIG -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $root
}
