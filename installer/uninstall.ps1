<#
  Removes an installed Ballast: the install folder, its shortcuts and its Apps & features entry.
  Ballast's data (~\.ballast, or BALLAST_HOME) is kept unless the user says to delete it.
  Run from the install folder (Start menu "Uninstall Ballast" or Apps & features).

    -Quiet          no dialogs; keeps the data unless -DeleteData
    -DeleteData     also delete the data folder (only meaningful with -Quiet)
    -DataDir <dir>  data folder to offer for deletion (default BALLAST_HOME or ~\.ballast)
#>
param(
  [switch]$Quiet,
  [switch]$DeleteData,
  [string]$DataDir
)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($PSScriptRoot)
$app = Join-Path $root 'app'
$LogPath = Join-Path $env:TEMP 'BallastUninstall.log'
Set-Location -LiteralPath $env:TEMP   # don't hold the install folder open

function Write-Log([string]$msg) {
  $line = '{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Write-Host $line
  try { Add-Content -Path $LogPath -Value $line -Encoding UTF8 } catch {}
}

Add-Type -AssemblyName System.Windows.Forms
function Show-Box([string]$Text, [string]$Buttons = 'OK', [string]$Icon = 'Information', [string]$Default = 'Button1', [string]$QuietAnswer) {
  Write-Log ("DIALOG [{0}]: {1}" -f $Buttons, ($Text -replace "`r?`n", ' | '))
  if ($Quiet) {
    if (-not $QuietAnswer) { $QuietAnswer = @{ OK = 'OK'; OKCancel = 'OK'; YesNo = 'Yes' }[$Buttons] }
    Write-Log "  quiet answer: $QuietAnswer"
    return $QuietAnswer
  }
  $owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true }
  try {
    $r = [System.Windows.Forms.MessageBox]::Show($owner, $Text, 'Uninstall Ballast',
      [System.Windows.Forms.MessageBoxButtons]$Buttons, [System.Windows.Forms.MessageBoxIcon]$Icon,
      [System.Windows.Forms.MessageBoxDefaultButton]$Default)
  } finally { $owner.Dispose() }
  Write-Log "  answer: $r"
  return $r.ToString()
}

function Test-PathInside([string]$child, [string]$parent) {
  $c = [IO.Path]::GetFullPath($child).TrimEnd('\') + '\'
  $p = [IO.Path]::GetFullPath($parent).TrimEnd('\') + '\'
  return $c.StartsWith($p, [StringComparison]::OrdinalIgnoreCase)
}

try {
  Write-Log "---- Uninstall Ballast from $root"
  if (-not (Test-Path (Join-Path $root 'install.json')) -or -not (Test-Path (Join-Path $root 'launch.ps1'))) {
    throw "$root doesn't look like a Ballast install (no install.json), so nothing was removed."
  }
  $manifest = Get-Content (Join-Path $root 'install.json') -Raw | ConvertFrom-Json

  if (-not $DataDir) { $DataDir = if ($env:BALLAST_HOME) { $env:BALLAST_HOME } else { Join-Path $env:USERPROFILE '.ballast' } }
  $DataDir = [IO.Path]::GetFullPath($DataDir)

  $a = Show-Box "Remove Ballast $($manifest.version) from this PC?`n`nYour Ballast data ($DataDir) is kept unless you choose to delete it in the next step." 'YesNo' 'Question'
  if ($a -ne 'Yes') { Write-Log 'Cancelled'; exit 3 }

  $removeData = $false
  if (Test-Path -LiteralPath $DataDir) {
    if ($Quiet) { $removeData = [bool]$DeleteData; Write-Log "Delete data: $removeData (quiet)" }
    else {
      $a = Show-Box ("Also delete your Ballast data?`n`n  $DataDir`n`nThis is your accounts' Claude logins, games, boards, feeds, builds and history. It can't be undone.`n`nChoose No to keep it (a later install picks it up again).") 'YesNo' 'Warning' 'Button2'
      $removeData = ($a -eq 'Yes')
    }
  }

  # Close a running copy from this install (and its agents).
  $needle = Join-Path $app 'src\server.mjs'
  $procs = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
  foreach ($p in $procs) { Write-Log "Stopping Ballast (pid $($p.ProcessId))"; & taskkill.exe /PID $p.ProcessId /T /F | Out-Null }
  if ($procs.Count) { Start-Sleep -Milliseconds 800 }

  foreach ($s in @($manifest.shortcuts)) {
    if ($s -and $s.EndsWith('.lnk') -and (Test-Path -LiteralPath $s)) { Remove-Item -LiteralPath $s -Force; Write-Log "Removed $s" }
  }
  if ($manifest.startMenuDir -and (Test-Path -LiteralPath $manifest.startMenuDir) -and
      -not (Get-ChildItem -LiteralPath $manifest.startMenuDir -Force)) {
    Remove-Item -LiteralPath $manifest.startMenuDir -Force; Write-Log "Removed $($manifest.startMenuDir)"
  }
  if ($manifest.registryKey -and (Test-Path $manifest.registryKey)) {
    Remove-Item -Path $manifest.registryKey -Recurse -Force; Write-Log "Removed $($manifest.registryKey)"
  }

  # The install folder. Never if it overlaps the data folder.
  if ((Test-PathInside $root $DataDir) -or (Test-PathInside $DataDir $root)) {
    throw "The install folder $root overlaps the data folder $DataDir; remove it by hand."
  }
  $failed = $false
  for ($i = 0; $i -lt 5; $i++) {
    try { Remove-Item -LiteralPath $root -Recurse -Force; break }
    catch { $failed = $true; Start-Sleep -Seconds 1 }
  }
  if (Test-Path -LiteralPath $root) { Write-Log "Could not fully remove $root" } else { $failed = $false; Write-Log "Removed $root" }

  if ($removeData) {
    $profileDir = [IO.Path]::GetFullPath($env:USERPROFILE).TrimEnd('\')
    if ($DataDir.TrimEnd('\') -eq $profileDir -or $DataDir.TrimEnd('\') -eq [IO.Path]::GetPathRoot($DataDir).TrimEnd('\')) {
      throw "Refusing to delete $DataDir."
    }
    for ($i = 0; $i -lt 5; $i++) {
      try { Remove-Item -LiteralPath $DataDir -Recurse -Force; break }
      catch { if ($i -eq 4) { throw "Couldn't delete $DataDir ($($_.Exception.Message)). Delete it by hand." }; Start-Sleep -Seconds 1 }
    }
    Write-Log "Deleted data $DataDir"
  }

  $msg = 'Ballast was removed.'
  if (-not $removeData -and (Test-Path -LiteralPath $DataDir)) { $msg += "`n`nYour data is still in $DataDir." }
  if ($failed) { $msg += "`n`nSome files in $root were in use and couldn't be deleted. Delete that folder after restarting." }
  Show-Box $msg 'OK' 'Information' | Out-Null
  exit 0
} catch {
  Write-Log "ERROR: $($_.Exception.Message)"
  Show-Box ("Uninstall ran into a problem:`n`n$($_.Exception.Message)`n`nDetails are in $LogPath") 'OK' 'Error' | Out-Null
  exit 1
}
