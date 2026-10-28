<#
  Ballast installer. BallastSetup.exe (IExpress) extracts this folder to a temp dir and runs
  install.cmd, which runs:  powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1

  Installs per-user (no admin needed) into %LOCALAPPDATA%\Programs\Ballast:
    app\            the Ballast app (replaced in place on upgrade)
    launch.ps1      starts Ballast with no console window, or opens the browser if it's running
    uninstall.ps1   removes the app, shortcuts and Apps & features entry (keeps ~\.ballast)
    hidden.vbs      runs those scripts without flashing a console
    ballast.ico, version.txt, install.json (what was installed, for the uninstaller), logs\
  Ballast's own data (~\.ballast, or BALLAST_HOME) is never touched.

  Test / dry-run switches (nothing here downloads or installs anything unless asked):
    -InstallRoot <dir>       install somewhere else
    -ShortcutRoot <dir>      put the Start menu and desktop shortcuts under <dir> instead
    -NoShortcuts             no shortcuts at all
    -RegistryKey <path>      Apps & features key (default HKCU:\...\Uninstall\Ballast)
    -NoRegistry              don't register in Apps & features
    -SkipPrereqs             don't check Node / Claude Code / git
    -CheckPrereqsOnly        report what's found, change nothing, exit
    -SimulateMissing a,b     pretend node / claude / git / winget are missing
    -Quiet                   no dialogs: confirmations answer Yes, install offers answer No,
                             "launch now?" answers No
    -NoLaunch                never launch at the end
#>
[CmdletBinding()]
param(
  [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'Programs\Ballast'),
  [string]$Payload,             # default: app.zip next to this script
  [string]$ShortcutRoot,
  [string]$RegistryKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Ballast',
  [switch]$NoShortcuts,
  [switch]$NoRegistry,
  [switch]$SkipPrereqs,
  [switch]$CheckPrereqsOnly,
  [string[]]$SimulateMissing = @(),
  [switch]$Quiet,
  [switch]$NoLaunch,
  [string]$LogPath = (Join-Path $env:TEMP 'BallastSetup.log')
)

$ErrorActionPreference = 'Stop'
if (-not $Payload) { $Payload = Join-Path $PSScriptRoot 'app.zip' }
$SimulateMissing = @($SimulateMissing | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim().ToLower() } | Where-Object { $_ })
$Title = 'Ballast Setup'
$NodeDownloadUrl = 'https://nodejs.org/en/download'
$ClaudeDocsUrl = 'https://docs.anthropic.com/en/docs/claude-code/setup'
$Version = 'dev'
$vf = Join-Path $PSScriptRoot 'version.txt'
if (Test-Path $vf) { $Version = (Get-Content $vf -Raw).Trim() }
$script:Warnings = New-Object System.Collections.Generic.List[string]

# ---------------------------------------------------------------------------- helpers

function Write-Log([string]$msg) {
  $line = '{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Write-Host $line
  try { Add-Content -Path $LogPath -Value $line -Encoding UTF8 } catch {}
}

Add-Type -AssemblyName System.Windows.Forms
# Buttons: OK, OKCancel, YesNo. Default: Button1 / Button2. Returns 'OK', 'Cancel', 'Yes', 'No'.
function Show-Box([string]$Text, [string]$Buttons = 'OK', [string]$Icon = 'Information', [string]$Default = 'Button1', [string]$QuietAnswer) {
  Write-Log ("DIALOG [{0}]: {1}" -f $Buttons, ($Text -replace "`r?`n", ' | '))
  if ($Quiet) {
    if (-not $QuietAnswer) { $QuietAnswer = @{ OK = 'OK'; OKCancel = 'OK'; YesNo = 'Yes' }[$Buttons] }
    Write-Log "  quiet answer: $QuietAnswer"
    return $QuietAnswer
  }
  $owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true }
  try {
    $r = [System.Windows.Forms.MessageBox]::Show($owner, $Text, $Title,
      [System.Windows.Forms.MessageBoxButtons]$Buttons, [System.Windows.Forms.MessageBoxIcon]$Icon,
      [System.Windows.Forms.MessageBoxDefaultButton]$Default)
  } finally { $owner.Dispose() }
  Write-Log "  answer: $r"
  return $r.ToString()
}

function Get-DataDir {
  if ($env:BALLAST_HOME) { return [IO.Path]::GetFullPath($env:BALLAST_HOME) }
  return (Join-Path $env:USERPROFILE '.ballast')
}

function Test-PathInside([string]$child, [string]$parent) {
  $c = [IO.Path]::GetFullPath($child).TrimEnd('\') + '\'
  $p = [IO.Path]::GetFullPath($parent).TrimEnd('\') + '\'
  return $c.StartsWith($p, [StringComparison]::OrdinalIgnoreCase)
}

# Refuse install roots that would be dangerous to mirror into or delete later.
function Assert-SafeInstallRoot([string]$root) {
  $full = [IO.Path]::GetFullPath($root).TrimEnd('\')
  $forbidden = @($env:USERPROFILE, $env:LOCALAPPDATA, $env:APPDATA, $env:ProgramFiles, ${env:ProgramFiles(x86)},
    $env:windir, (Join-Path $env:LOCALAPPDATA 'Programs'), [IO.Path]::GetPathRoot($full)) |
    Where-Object { $_ } | ForEach-Object { [IO.Path]::GetFullPath($_).TrimEnd('\') }
  if ($forbidden -contains $full) { throw "Refusing to install directly into $full. Choose a dedicated folder." }
  $data = Get-DataDir
  if ((Test-PathInside $full $data) -or (Test-PathInside $data $full)) {
    throw "Refusing to install into $full because it overlaps Ballast's data folder ($data)."
  }
}

# Machine + user PATH from the registry, so tools installed a moment ago are found.
function Update-SessionPath {
  $parts = @([Environment]::GetEnvironmentVariable('Path', 'Machine'), [Environment]::GetEnvironmentVariable('Path', 'User'),
    (Join-Path $env:USERPROFILE '.local\bin'))
  $env:Path = ($parts | Where-Object { $_ }) -join ';'
}

# First line of `<tool> --version`, or $null if the tool isn't there. Times out after 20s.
function Get-ToolVersion([string]$Name) {
  if ($SimulateMissing -contains $Name) { return $null }
  $cmd = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  $path = if ($cmd) { $cmd.Source } else { $null }
  if (-not $path -and $Name -eq 'claude') {
    $p = Join-Path $env:USERPROFILE '.local\bin\claude.exe'
    if (Test-Path $p) { $path = $p }
  }
  if (-not $path) { return $null }
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = 'cmd.exe'
  $psi.Arguments = '/d /c ""' + $path + '" --version"'
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true
  try {
    $proc = [System.Diagnostics.Process]::Start($psi)
    $outTask = $proc.StandardOutput.ReadToEndAsync()
    $null = $proc.StandardError.ReadToEndAsync()
    if (-not $proc.WaitForExit(20000)) { try { $proc.Kill() } catch {}; return 'found (version check timed out)' }
    $out = $outTask.Result.Trim()
    if ($proc.ExitCode -ne 0 -or -not $out) { return $null }
    return ($out -split "`r?`n")[0].Trim()
  } catch { return $null }
}

function Get-NodeMajor([string]$ver) {
  if ($ver -match 'v?(\d+)\.') { return [int]$Matches[1] }
  return 0
}

function Get-Winget {
  if ($SimulateMissing -contains 'winget') { return $null }
  $c = Get-Command winget -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($c) { return $c.Source }
  $alias = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\winget.exe'
  if (Test-Path $alias) { return $alias }
  return $null
}

# Runs winget in its own visible window and waits. Returns the exit code.
function Invoke-WingetInstall([string]$winget, [string]$Id) {
  $wingetArgs = "install -e --id $Id --accept-package-agreements --accept-source-agreements"
  Write-Log "Running: winget $wingetArgs"
  $p = Start-Process -FilePath $winget -ArgumentList $wingetArgs -Wait -PassThru
  Write-Log "winget exit code: $($p.ExitCode)"
  Update-SessionPath
  return $p.ExitCode
}

function Get-BallastProcesses([string]$appDir) {
  $needle = Join-Path $appDir 'src\server.mjs'
  @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
}

function Test-VbScript { Test-Path (Join-Path $env:windir 'System32\vbscript.dll') }

function New-Shortcut([string]$Path, [string]$Target, [string]$Arguments, [string]$Icon, [string]$Description, [string]$WorkDir, [int]$WindowStyle = 1) {
  New-Item -ItemType Directory -Force -Path (Split-Path $Path) | Out-Null
  $sh = New-Object -ComObject WScript.Shell
  $lnk = $sh.CreateShortcut($Path)
  $lnk.TargetPath = $Target
  $lnk.Arguments = $Arguments
  $lnk.IconLocation = "$Icon,0"
  $lnk.Description = $Description
  $lnk.WorkingDirectory = $WorkDir
  $lnk.WindowStyle = $WindowStyle
  $lnk.Save()
  Write-Log "Shortcut: $Path"
}

# ---------------------------------------------------------------------------- prerequisites

function Confirm-Node {
  $v = Get-ToolVersion 'node'
  if ($v -and (Get-NodeMajor $v) -ge 20) { Write-Log "Node.js $v OK"; return $true }
  $why = if ($v) { "Ballast needs Node.js 20 or newer, and this PC has $v." } else { 'Ballast needs Node.js 20 or newer, and it is not installed.' }
  Write-Log $why
  $winget = Get-Winget
  if (-not $winget) {
    Show-Box ("$why`n`nPlease install the LTS version of Node.js from $NodeDownloadUrl (the browser will open there), then run BallastSetup.exe again.") 'OK' 'Warning' | Out-Null
    if (-not $Quiet) { Start-Process $NodeDownloadUrl }
    return $false
  }
  $a = Show-Box ("$why`n`nInstall Node.js LTS now? Setup will run:`n  winget install -e --id OpenJS.NodeJS.LTS`n`nThis accepts the Node.js and winget terms. Windows may ask for permission.") 'YesNo' 'Question' 'Button1' 'No'
  if ($a -ne 'Yes') {
    Show-Box "Ballast can't run without Node.js 20+. Install it from $NodeDownloadUrl and run BallastSetup.exe again." 'OK' 'Warning' | Out-Null
    return $false
  }
  Invoke-WingetInstall $winget 'OpenJS.NodeJS.LTS' | Out-Null
  $v = Get-ToolVersion 'node'
  if ($v -and (Get-NodeMajor $v) -ge 20) { Write-Log "Node.js $v installed"; return $true }
  Show-Box "Node.js didn't install. Install the LTS version from $NodeDownloadUrl (the browser will open there), then run BallastSetup.exe again." 'OK' 'Error' | Out-Null
  if (-not $Quiet) { Start-Process $NodeDownloadUrl }
  return $false
}

function Confirm-Claude {
  $v = Get-ToolVersion 'claude'
  if ($v) { Write-Log "Claude Code $v OK"; return }
  $manual = "To install it yourself: open PowerShell from the Start menu and run`n  irm https://claude.ai/install.ps1 | iex`nor follow $ClaudeDocsUrl"
  $a = Show-Box ("Ballast runs your agents with Claude Code, which isn't installed yet.`n`nInstall it now with the official installer? Setup will run:`n  irm https://claude.ai/install.ps1 | iex") 'YesNo' 'Question' 'Button1' 'No'
  if ($a -ne 'Yes') { $script:Warnings.Add("Claude Code isn't installed. $manual"); return }
  Write-Log 'Running the Claude Code installer'
  $p = Start-Process -FilePath 'powershell.exe' -Wait -PassThru -ArgumentList '-NoProfile -ExecutionPolicy Bypass -Command "irm https://claude.ai/install.ps1 | iex"'
  Write-Log "Claude installer exit code: $($p.ExitCode)"
  Update-SessionPath
  $v = Get-ToolVersion 'claude'
  if ($v) { Write-Log "Claude Code $v installed"; return }
  Show-Box ("The Claude Code installer didn't finish.`n`n$manual`n`nSetup will carry on installing Ballast.") 'OK' 'Warning' | Out-Null
  $script:Warnings.Add("Claude Code isn't installed. $manual")
}

function Confirm-Git {
  $v = Get-ToolVersion 'git'
  if ($v) { Write-Log "$v OK"; return }
  $winget = Get-Winget
  $manual = 'Install it from https://git-scm.com/download/win'
  if (-not $winget) { $script:Warnings.Add("git isn't installed (Ballast uses it for your games). $manual"); return }
  $a = Show-Box ("Ballast uses git to keep each agent's work apart, and git isn't installed.`n`nInstall it now? Setup will run:`n  winget install -e --id Git.Git`n`nThis accepts the Git and winget terms. Windows may ask for permission.") 'YesNo' 'Question' 'Button1' 'No'
  if ($a -ne 'Yes') { $script:Warnings.Add("git isn't installed (Ballast uses it for your games). $manual"); return }
  Invoke-WingetInstall $winget 'Git.Git' | Out-Null
  if (Get-ToolVersion 'git') { Write-Log 'git installed'; return }
  $script:Warnings.Add("git didn't install. $manual")
}

# ---------------------------------------------------------------------------- install

function Install-Ballast {
  Update-SessionPath
  $root = [IO.Path]::GetFullPath($InstallRoot)
  $app = Join-Path $root 'app'
  $manifestPath = Join-Path $root 'install.json'
  Write-Log "Ballast $Version setup. Install root: $root"

  if ($CheckPrereqsOnly) {
    foreach ($t in 'node', 'claude', 'git') { Write-Log ("{0}: {1}" -f $t, $(if ($v = Get-ToolVersion $t) { $v } else { 'MISSING' })) }
    Write-Log ("winget: {0}" -f $(if ($w = Get-Winget) { $w } else { 'MISSING' }))
    return 0
  }

  Assert-SafeInstallRoot $root
  if (-not (Test-Path $Payload)) { throw "The app payload is missing ($Payload)." }

  $previous = $null
  if (Test-Path $manifestPath) { try { $previous = Get-Content $manifestPath -Raw | ConvertFrom-Json } catch {} }
  $intro = if ($previous) { "Update Ballast from $($previous.version) to ${Version}?" } else { "Install Ballast ${Version}?" }
  $a = Show-Box ("$intro`n`nIt installs for your Windows account only, into`n  $root`n`nYour Ballast data (accounts, games, boards in $(Get-DataDir)) is never touched.") 'OKCancel' 'Information'
  if ($a -ne 'OK') { Write-Log 'Cancelled by user'; return 3 }

  if ($SkipPrereqs) { Write-Log 'Skipping prerequisite checks (-SkipPrereqs)' }
  else {
    if (-not (Confirm-Node)) { Write-Log 'Stopping: Node.js 20+ is required'; return 2 }
    Confirm-Claude
    Confirm-Git
  }

  # A running copy from this install would hold the folder open: close it first.
  $running = @(Get-BallastProcesses $app)
  if ($running.Count) {
    $a = Show-Box "Ballast is running. Setup needs to close it to update it (you can start it again at the end).`n`nClose Ballast now?" 'YesNo' 'Question'
    if ($a -ne 'Yes') { Write-Log 'User kept Ballast running; stopping setup'; return 3 }
    foreach ($p in $running) { Write-Log "Stopping Ballast (pid $($p.ProcessId))"; & taskkill.exe /PID $p.ProcessId /T /F | Out-Null }
    Start-Sleep -Milliseconds 800
  }

  # Unpack the app next to us, then mirror it into app\ (removes files that no longer ship).
  $stage = Join-Path $env:TEMP ('ballast-setup-' + [guid]::NewGuid().ToString('N'))
  try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::ExtractToDirectory($Payload, $stage)
    if (-not (Test-Path (Join-Path $stage 'src\server.mjs'))) { throw 'The app payload is incomplete (no src\server.mjs).' }
    New-Item -ItemType Directory -Force -Path $app | Out-Null
    Write-Log "Copying app to $app"
    & robocopy.exe $stage $app /MIR /R:3 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "Copying the app failed (robocopy exit code $LASTEXITCODE). Is a file in $app open?" }
  } finally {
    if (Test-Path $stage) { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue }
  }
  foreach ($f in 'launch.ps1', 'uninstall.ps1', 'hidden.vbs', 'ballast.ico', 'version.txt') {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $f) -Destination (Join-Path $root $f) -Force
  }
  New-Item -ItemType Directory -Force -Path (Join-Path $root 'logs') | Out-Null

  # How shortcuts run a script with no console window.
  $icon = Join-Path $root 'ballast.ico'
  $wscript = Join-Path $env:windir 'System32\wscript.exe'
  $powershell = Join-Path $env:windir 'System32\WindowsPowerShell\v1.0\powershell.exe'
  function Get-Runner([string]$script, [string]$extra = '') {
    if (Test-VbScript) { return @($wscript, ("`"$root\hidden.vbs`" $script $extra").Trim(), 1) }
    return @($powershell, ("-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$root\$script`" $extra").Trim(), 7)
  }

  $shortcuts = @()
  $startDir = $null
  if (-not $NoShortcuts) {
    if ($ShortcutRoot) {
      $startDir = Join-Path $ShortcutRoot 'StartMenu\Ballast'
      $desktop = Join-Path $ShortcutRoot 'Desktop'
    } else {
      $startDir = Join-Path ([Environment]::GetFolderPath('Programs')) 'Ballast'
      $desktop = [Environment]::GetFolderPath('Desktop')
    }
    $run = Get-Runner 'launch.ps1'
    $stop = Get-Runner 'launch.ps1' '-Stop'
    $uninst = Get-Runner 'uninstall.ps1'
    $items = @(
      @((Join-Path $startDir 'Ballast.lnk'), $run, 'Start Ballast and open it in your browser'),
      @((Join-Path $desktop 'Ballast.lnk'), $run, 'Start Ballast and open it in your browser'),
      @((Join-Path $startDir 'Stop Ballast.lnk'), $stop, 'Stop Ballast and its agents'),
      @((Join-Path $startDir 'Uninstall Ballast.lnk'), $uninst, 'Remove Ballast (keeps your data unless you ask)')
    )
    foreach ($it in $items) {
      New-Shortcut -Path $it[0] -Target $it[1][0] -Arguments $it[1][1] -WindowStyle $it[1][2] -Icon $icon -Description $it[2] -WorkDir $root
      $shortcuts += $it[0]
    }
  }

  $uninstallCmd = Get-Runner 'uninstall.ps1'
  if (-not $NoRegistry) {
    Write-Log "Registering in Apps & features: $RegistryKey"
    New-Item -Path $RegistryKey -Force | Out-Null
    $sizeKb = [int]((Get-ChildItem -LiteralPath $root -Recurse -File | Measure-Object Length -Sum).Sum / 1KB)
    $values = [ordered]@{
      DisplayName = 'Ballast'; DisplayVersion = $Version; Publisher = 'Ballast'
      DisplayIcon = $icon; InstallLocation = $root; InstallDate = (Get-Date -Format 'yyyyMMdd')
      UninstallString = ('"{0}" {1}' -f $uninstallCmd[0], $uninstallCmd[1])
      QuietUninstallString = ('"{0}" {1} -Quiet' -f $uninstallCmd[0], $uninstallCmd[1])
    }
    foreach ($k in $values.Keys) { New-ItemProperty -Path $RegistryKey -Name $k -Value $values[$k] -PropertyType String -Force | Out-Null }
    foreach ($k in 'NoModify', 'NoRepair') { New-ItemProperty -Path $RegistryKey -Name $k -Value 1 -PropertyType DWord -Force | Out-Null }
    New-ItemProperty -Path $RegistryKey -Name 'EstimatedSize' -Value $sizeKb -PropertyType DWord -Force | Out-Null
  }

  [ordered]@{
    version = $Version; installedAt = (Get-Date).ToString('o'); installRoot = $root
    shortcuts = $shortcuts; startMenuDir = $startDir
    registryKey = $(if ($NoRegistry) { $null } else { $RegistryKey })
  } | ConvertTo-Json | Set-Content -LiteralPath $manifestPath -Encoding UTF8
  Write-Log 'Install complete'

  $msg = "Ballast $Version is installed. Start it any time from the Start menu or the Ballast icon on your desktop."
  if ($NoShortcuts) { $msg = "Ballast $Version is installed in $root." }
  if ($script:Warnings.Count) { $msg += "`n`nBefore you start:`n- " + ($script:Warnings -join "`n- ") }
  if ($NoLaunch) { Show-Box $msg 'OK' 'Information' | Out-Null; return 0 }
  $a = Show-Box "$msg`n`nLaunch Ballast now?" 'YesNo' 'Question' 'Button1' 'No'
  if ($a -eq 'Yes') {
    $lnk = $shortcuts | Where-Object { $_ -like '*\Ballast.lnk' } | Select-Object -First 1
    # Going through Explorer starts Ballast as the normal (non-elevated) user even if setup was elevated.
    if ($lnk) { Start-Process -FilePath (Join-Path $env:windir 'explorer.exe') -ArgumentList "`"$lnk`"" }
    else { $r = Get-Runner 'launch.ps1'; Start-Process -FilePath $r[0] -ArgumentList $r[1] }
    Write-Log 'Launched Ballast'
  }
  return 0
}

try {
  Write-Log "---- $Title $Version ($PSCommandPath) args: $($MyInvocation.Line)"
  $code = Install-Ballast | Select-Object -Last 1
  Write-Log "Exit code $code"
  exit $code
} catch {
  Write-Log "ERROR: $($_.Exception.Message)`n$($_.ScriptStackTrace)"
  Show-Box ("Setup ran into a problem:`n`n$($_.Exception.Message)`n`nDetails are in $LogPath") 'OK' 'Error' | Out-Null
  exit 1
}
