$ErrorActionPreference = 'Stop'

$regPath = 'HKCU:\Software\Mozilla\NativeMessagingHosts\claude_email_search'
if (Test-Path $regPath) {
    Remove-Item -Path $regPath -Force
    Write-Host "Registry key removed."
} else {
    Write-Host "Registry key not found — nothing to remove."
}

$hostDir     = Split-Path -Parent $MyInvocation.MyCommand.Path
$manifestOut = Join-Path $hostDir 'claude_email_search.json'
if (Test-Path $manifestOut) {
    Remove-Item -Path $manifestOut -Force
    Write-Host "Manifest file removed."
}

Write-Host "Uninstall complete. Restart Thunderbird."
