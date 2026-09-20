$ErrorActionPreference='Stop'
if(-not(Get-Command kilo -ErrorAction SilentlyContinue)){throw 'Kilo Code CLI not found in PATH.'}
$paths=(& kilo debug paths|Out-String);if($LASTEXITCODE-ne 0){throw 'kilo debug paths failed.'}
$line=@($paths-split "`r?`n")|Where-Object{$_-match '^\s*config\s+(.+?)\s*$'}|Select-Object -First 1;if(-not $line-or $line-notmatch '^\s*config\s+(.+?)\s*$'){throw 'Could not resolve Kilo config directory.'}
$root=[IO.Path]::GetFullPath($Matches[1]);$dst=Join-Path $root 'zero-mem';New-Item -ItemType Directory -Force $dst|Out-Null;Copy-Item -Recurse -Force (Join-Path $PSScriptRoot 'src') $dst;Copy-Item -Force (Join-Path $PSScriptRoot 'package.json') $dst
$spec='file://'+(($dst-replace '\\','/'))
Write-Host "Installed Zero-Mem files: $dst";Write-Host "Register globally with Kilo plugin install if available:";Write-Host "  kilo plugin install `"$spec`" --global";Write-Host "Or add `"$spec`" to the global config plugin array, then restart Kilo."
