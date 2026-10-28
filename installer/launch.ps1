<#
  Starts the installed Ballast with no console window and lets it open the browser.
  If something already answers on the port, it just opens the browser there.
  Shortcuts run it through hidden.vbs:  wscript.exe hidden.vbs launch.ps1 [args]

    -Port <n>       port to use (default 4477)
    -NoBrowser      don't open a browser (passes --no-open to Ballast)
    -Stop           stop the Ballast started from this install (asks first)
    -Quiet          no dialogs (errors only go to logs\launcher.log and the exit code)
#>
param(
  [int]$Port = 4477,
  [switch]$NoBrowser,
  [switch]$Stop,
  [switch]$Quiet,
  [int]$TimeoutSec = 45
)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$app = Join-Path $root 'app'
$server = Join-Path $app 'src\server.mjs'
$logs = Join-Path $root 'logs'
New-Item -ItemType Directory -Force -Path $logs | Out-Null
$logFile = Join-Path $logs 'launcher.log'
$url = "http://127.0.0.1:$Port/"

function Write-Log([string]$msg) {
  try { Add-Content -Path $logFile -Value ('{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg) -Encoding UTF8 } catch {}
}

function Show-Box([string]$Text, [string]$Buttons = 'OK', [string]$Icon = 'Information') {
  Write-Log "DIALOG: $($Text -replace "`r?`n", ' | ')"
  if ($Quiet) { return $(if ($Buttons -eq 'YesNo') { 'Yes' } else { 'OK' }) }
  Add-Type -AssemblyName System.Windows.Forms
  $owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true }
  try { return [System.Windows.Forms.MessageBox]::Show($owner, $Text, 'Ballast', $Buttons, $Icon).ToString() }
  finally { $owner.Dispose() }
}

# Anything answering HTTP on the port counts as "running" (even an error status).
function Test-Up {
  try {
    $req = [System.Net.HttpWebRequest]::Create($url)
    $req.Proxy = $null
    $req.Timeout = 2000
    $req.GetResponse().Close()
    return $true
  } catch [System.Net.WebException] {
    if ($_.Exception.Response) { $_.Exception.Response.Close(); return $true }
    return $false
  } catch { return $false }
}

function Get-BallastProcesses {
  @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($server, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
}

function Open-Browser { if (-not $NoBrowser) { Start-Process $url } }

try {
  if ($Stop) {
    $procs = @(Get-BallastProcesses)
    if (-not $procs.Count) { Show-Box 'Ballast is not running.' | Out-Null; exit 0 }
    $a = Show-Box "Stop Ballast? Any agent turns in progress are interrupted; their tasks go back on the board next time Ballast starts." 'YesNo' 'Question'
    if ($a -ne 'Yes') { exit 0 }
    foreach ($p in $procs) { Write-Log "Stopping pid $($p.ProcessId)"; & taskkill.exe /PID $p.ProcessId /T /F | Out-Null }
    exit 0
  }

  if (Test-Up) { Write-Log "Already running on $url; opening the browser"; Open-Browser; exit 0 }

  # Use the PATH as it is now, not as it was when this session started (fresh Node/git/claude installs).
  $env:Path = (@([Environment]::GetEnvironmentVariable('Path', 'Machine'), [Environment]::GetEnvironmentVariable('Path', 'User'),
      (Join-Path $env:USERPROFILE '.local\bin'), $env:Path) | Where-Object { $_ }) -join ';'
  $node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $node) {
    Show-Box "Ballast needs Node.js 20 or newer, and it wasn't found.`n`nInstall the LTS version from https://nodejs.org/en/download, then start Ballast again." 'OK' 'Error' | Out-Null
    exit 2
  }

  $env:BALLAST_PORT = "$Port"
  $nodeArgs = "`"$server`" $Port"
  if ($NoBrowser) { $nodeArgs += ' --no-open' }
  $out = Join-Path $logs 'ballast.log'
  $err = Join-Path $logs 'ballast-error.log'
  Write-Log "Starting: $($node.Source) $nodeArgs"
  # -NoNewWindow: node shares this script's hidden console, so no window appears.
  $proc = Start-Process -FilePath $node.Source -ArgumentList $nodeArgs -WorkingDirectory $app -NoNewWindow -PassThru `
    -RedirectStandardOutput $out -RedirectStandardError $err

  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    if (Test-Up) { Write-Log "Ballast is up on $url (pid $($proc.Id))"; exit 0 }   # Ballast opens the browser itself
    if ($proc.HasExited) { break }
    Start-Sleep -Milliseconds 400
  }
  $tail = ''
  if (Test-Path $err) { $tail = (Get-Content $err -Tail 8 -ErrorAction SilentlyContinue) -join "`n" }
  Write-Log "Ballast didn't start. $tail"
  Show-Box ("Ballast didn't start.`n`n$tail`n`nThe full log is in $logs") 'OK' 'Error' | Out-Null
  exit 1
} catch {
  Write-Log "ERROR: $($_.Exception.Message)"
  Show-Box "Ballast couldn't start: $($_.Exception.Message)" 'OK' 'Error' | Out-Null
  exit 1
}
