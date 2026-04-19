$ErrorActionPreference = 'Stop'

$hostDir     = Split-Path -Parent $MyInvocation.MyCommand.Path
$exePath     = Join-Path $hostDir 'host-launcher.exe'
$manifestOut = Join-Path $hostDir 'claude_email_search.json'

# ── 1. Compile a tiny C# launcher exe ────────────────────────────────────────
# Native messaging on Windows requires a real .exe — Gecko uses CreateProcess
# which cannot execute .cmd/.bat files. The launcher inherits Thunderbird's
# stdin/stdout pipes and forwards them to node.exe transparently.
#
# PS7 dropped ConsoleApplication support in Add-Type, so we delegate to
# Windows PowerShell 5.1 (powershell.exe) which always has it on Windows.

$csCode = @'
using System;
using System.Diagnostics;
using System.IO;

class Launcher {
    static int Main() {
        string dir    = AppDomain.CurrentDomain.BaseDirectory;
        string script = Path.GetFullPath(
            Path.Combine(dir, "..", "dist", "native-host", "host.cjs"));

        ProcessStartInfo psi = new ProcessStartInfo();
        psi.FileName        = "node.exe";
        psi.Arguments       = "\"" + script + "\"";
        psi.UseShellExecute = false;
        // No redirection: node inherits Thunderbird's stdin/stdout pipes.

        Process p = Process.Start(psi);
        if (p == null) { Environment.Exit(1); }
        p.WaitForExit();
        return p.ExitCode;
    }
}
'@

$csFile = Join-Path $env:TEMP 'claude_host_launcher.cs'
$ps1File = Join-Path $env:TEMP 'compile_claude_host.ps1'

Set-Content -Path $csFile  -Value $csCode  -Encoding UTF8
Set-Content -Path $ps1File -Value "Add-Type -Path '$csFile' -OutputAssembly '$exePath' -OutputType ConsoleApplication" -Encoding UTF8

Write-Host "Compiling host-launcher.exe (via Windows PowerShell 5.1)..."
powershell.exe -NonInteractive -ExecutionPolicy Bypass -File $ps1File
if ($LASTEXITCODE -ne 0) {
    Write-Error "Compilation failed. Ensure .NET Framework 4.x is available (comes with Windows)."
}

Remove-Item $csFile, $ps1File -ErrorAction SilentlyContinue
Write-Host "  -> $exePath"

# ── 2. Write the native messaging manifest ────────────────────────────────────
$manifest = [ordered]@{
    name               = 'claude_email_search'
    description        = 'Claude CLI native messaging host for Thunderbird email search'
    path               = $exePath
    type               = 'stdio'
    allowed_extensions = @('claude-email-search@local')
}
$manifest | ConvertTo-Json | Set-Content -Path $manifestOut -Encoding UTF8
Write-Host "  -> $manifestOut"

# ── 3. Register in Windows registry (no admin required) ───────────────────────
$regPath = 'HKCU:\Software\Mozilla\NativeMessagingHosts\claude_email_search'
New-Item -Path $regPath -Force | Out-Null
Set-ItemProperty -Path $regPath -Name '(Default)' -Value $manifestOut
Write-Host "  -> $regPath"

Write-Host ""
Write-Host "Done. Restart Thunderbird and reload the extension."
