$ErrorActionPreference = 'Stop'

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

$configRoot = [IO.Path]::GetFullPath($Matches[1])
$pluginRoot = Join-Path $configRoot 'zero-mem'
$spec = 'file://' + (($pluginRoot -replace '\\','/'))
$escapedSpec = [Regex]::Escape($spec)

$configFiles = @(
  (Join-Path $configRoot 'opencode.json'),
  (Join-Path $configRoot 'opencode.jsonc')
)

$changed = @()
foreach ($file in $configFiles) {
  if (-not (Test-Path -LiteralPath $file)) { continue }
  $text = Get-Content -Raw -LiteralPath $file
  if ($text -notmatch $escapedSpec) { continue }

  $backup = "$file.zero-mem-uninstall.bak"
  Copy-Item -Force -LiteralPath $file -Destination $backup

  $quoted = '"\s*' + $escapedSpec + '\s*"'
  $next = [Regex]::Replace($text, $quoted + '\s*,', '', 1)
  if ($next -eq $text) {
    $next = [Regex]::Replace($text, ',\s*' + $quoted, '', 1)
  }
  if ($next -eq $text) {
    $next = [Regex]::Replace($text, $quoted, '', 1)
  }
  if ($next -eq $text) {
    throw "Found Zero-Mem spec in $file but could not remove it safely. Backup: $backup"
  }

  Set-Content -LiteralPath $file -Value $next -Encoding UTF8
  $changed += $file
}

if (Test-Path -LiteralPath $pluginRoot) {
  Remove-Item -Recurse -Force -LiteralPath $pluginRoot
}

Write-Host ''
Write-Host 'PASS: Zero-Mem uninstalled.' -ForegroundColor Green
if ($changed.Count -gt 0) {
  Write-Host 'Updated global Kilo config:'
  $changed | ForEach-Object { Write-Host "  $_" }
  Write-Host 'Backups use the .zero-mem-uninstall.bak suffix.'
} else {
  Write-Host 'No Zero-Mem registration was found in global Kilo config.'
}
Write-Host 'Restart Kilo Code CLI if it is currently running.'
