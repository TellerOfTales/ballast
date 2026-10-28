<#
  Exercises the built BallastSetup.exe without touching a real install, real shortcuts,
  the real Apps & features entry or ~\.ballast:
    - extracts the exe's payload (BallastSetup.exe /Q /C /T:<temp>)
    - install.ps1 into a temp InstallRoot, shortcuts under a temp folder, registry under
      HKCU:\Software\BallastInstallerTest, BALLAST_HOME pointed at a temp folder
    - prerequisite branches via -CheckPrereqsOnly / -SimulateMissing (never runs winget or the Claude installer)
    - upgrade in place, launcher on -Port (default 4480) with --no-open, second launch, -Stop
    - uninstall via the registered QuietUninstallString, then reinstall + uninstall -DeleteData
  Everything is removed at the end.

    powershell -NoProfile -ExecutionPolicy Bypass -File installer\test-install.ps1 [-TestPort 4480] [-SkipLaunch]
#>
param([int]$TestPort = 4480, [switch]$SkipLaunch, [switch]$KeepTemp)
$ErrorActionPreference = 'Stop'
$exe = Join-Path $PSScriptRoot 'dist\BallastSetup.exe'
if (-not (Test-Path $exe)) { throw "Build first: $exe not found" }
if ($TestPort -eq 4477) { throw 'Use a port other than 4477 for testing' }

$t = Join-Path $env:TEMP ('ballast-installer-test-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$extract = Join-Path $t 'extract'
$root = Join-Path $t 'Programs\Ballast'
$sc = Join-Path $t 'shortcuts'
$dataHome = Join-Path $t 'home'
$log = Join-Path $t 'setup.log'
$regBase = 'HKCU:\Software\BallastInstallerTest'
$reg = "$regBase\Uninstall\Ballast"
$realReg = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Ballast'
$realStart = Join-Path ([Environment]::GetFolderPath('Programs')) 'Ballast'
$realDesk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Ballast.lnk'
$before = @{ reg = (Test-Path $realReg); start = (Test-Path $realStart); desk = (Test-Path $realDesk)
  unlog = (Test-Path (Join-Path $env:TEMP 'BallastUninstall.log')); setuplog = (Test-Path (Join-Path $env:TEMP 'BallastSetup.log')) }
$env:BALLAST_HOME = $dataHome          # children inherit this: nothing can reach the real ~\.ballast
New-Item -ItemType Directory -Force -Path $t, $dataHome | Out-Null
Set-Content (Join-Path $dataHome 'marker.txt') 'test data'

$results = New-Object System.Collections.Generic.List[object]
function Check([string]$name, [scriptblock]$cond) {
  $ok = $false; try { $ok = [bool](& $cond) } catch { $ok = $false }
  $results.Add([pscustomobject]@{ Result = $(if ($ok) { 'PASS' } else { 'FAIL' }); Check = $name })
  Write-Host ("[{0}] {1}" -f $(if ($ok) { 'PASS' } else { 'FAIL' }), $name)
}
function Run-PS([string]$file, [string[]]$a) {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $file @a | Out-Null
  return $LASTEXITCODE
}
function Test-Up([int]$port) {
  try { $r = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$port/"); $r.Proxy = $null; $r.Timeout = 2000; $r.GetResponse().Close(); $true }
  catch [System.Net.WebException] { [bool]$_.Exception.Response } catch { $false }
}
function Get-TestNode { @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($root, [StringComparison]::OrdinalIgnoreCase) -ge 0 }) }
function Wait-For([scriptblock]$cond, [int]$sec) { $d = (Get-Date).AddSeconds($sec); while ((Get-Date) -lt $d) { if (& $cond) { return $true }; Start-Sleep -Milliseconds 500 }; return [bool](& $cond) }

try {
  # 1. Extract the real exe's payload.
  $p = Start-Process -FilePath $exe -ArgumentList "/Q /C /T:$extract" -Wait -PassThru
  Check 'exe extracts its payload (/Q /C /T:)' { $p.ExitCode -eq 0 -and (Test-Path "$extract\install.ps1") -and (Test-Path "$extract\app.zip") }
  $installer = Join-Path $extract 'install.ps1'
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [System.IO.Compression.ZipFile]::OpenRead("$extract\app.zip")
  $entries = @($zip.Entries | ForEach-Object { $_.FullName -replace '/', '\' }); $zip.Dispose()
  Check 'payload has src\server.mjs, public\, README.md, package.json' { ($entries -contains 'src\server.mjs') -and ($entries -contains 'public\index.html') -and ($entries -contains 'README.md') -and ($entries -contains 'package.json') }
  Check 'payload has no .git, installer, .ballast, node_modules' { -not ($entries | Where-Object { $_ -match '(^|\\)(\.git|installer|\.ballast|node_modules)(\\|$)' }) }

  # 1b. The exe's own chain (wextract -> cmd -> install.cmd -> install.ps1), with the command
  #     overridden by /C: so it installs into temp instead of the real location.
  #     wextract hangs on an over-long /C: command, so this uses a short temp path and the default log.
  $chainRoot = Join-Path $env:TEMP ('bxc' + $t.Substring($t.Length - 4))
  $chainCmd = "cmd.exe /d /c .\install.cmd -Quiet -NoLaunch -SkipPrereqs -NoShortcuts -NoRegistry -InstallRoot $chainRoot"
  if ($chainCmd.Length -gt 200) { throw "TEMP path too long for the /C: chain test ($($chainCmd.Length) chars)" }
  $p = Start-Process -FilePath $exe -Wait -PassThru -ArgumentList "/Q /C:`"$chainCmd`""
  $setupLog = Join-Path $env:TEMP 'BallastSetup.log'
  if (-not $before.setuplog -and (Test-Path $setupLog)) { Get-Content $setupLog | Add-Content $log; Remove-Item $setupLog -Force }
  Check 'exe -> install.cmd -> install.ps1 chain installs (temp root)' { $p.ExitCode -eq 0 -and (Test-Path "$chainRoot\app\src\server.mjs") -and (Test-Path "$chainRoot\install.json") }
  if (Test-Path "$chainRoot\uninstall.ps1") { $c = Run-PS "$chainRoot\uninstall.ps1" @('-Quiet') }
  Check 'chain install uninstalls cleanly' { -not (Test-Path $chainRoot) -and (Test-Path "$dataHome\marker.txt") }

  # 2. Prerequisite branches (no installs run).
  $c = Run-PS $installer @('-CheckPrereqsOnly', '-LogPath', $log)
  Check 'prereq detection runs (-CheckPrereqsOnly)' { $c -eq 0 }
  Write-Host ((Get-Content $log | Select-String 'node:|claude:|git:|winget:') -join "`n")
  $missingRoot = Join-Path $t 'Programs\NoNode'
  $c = Run-PS $installer @('-Quiet', '-SimulateMissing', 'node', '-InstallRoot', $missingRoot, '-NoShortcuts', '-NoRegistry', '-LogPath', $log)
  Check 'Node missing + offer declined -> stops (exit 2), nothing installed' { $c -eq 2 -and -not (Test-Path "$missingRoot\app") }
  $c = Run-PS $installer @('-Quiet', '-SimulateMissing', 'node,winget', '-InstallRoot', $missingRoot, '-NoShortcuts', '-NoRegistry', '-LogPath', $log)
  Check 'Node + winget missing -> points at nodejs.org and stops' { $c -eq 2 -and (Select-String -Path $log -Pattern 'nodejs.org/en/download' -Quiet) }

  # 3. Fresh install (Claude Code and git simulated missing: offers declined, warnings shown).
  $c = Run-PS $installer @('-Quiet', '-NoLaunch', '-SimulateMissing', 'claude,git', '-InstallRoot', $root, '-ShortcutRoot', $sc, '-RegistryKey', $reg, '-LogPath', $log)
  Check 'install exit code 0' { $c -eq 0 }
  Check 'warnings for missing Claude Code and git' { (Select-String -Path $log -Pattern "Claude Code isn't installed" -Quiet) -and (Select-String -Path $log -Pattern "git isn't installed" -Quiet) }
  Check 'app copied (src\server.mjs, public\index.html, package.json, README.md)' { (Test-Path "$root\app\src\server.mjs") -and (Test-Path "$root\app\public\index.html") -and (Test-Path "$root\app\package.json") -and (Test-Path "$root\app\README.md") }
  $installed = @(Get-ChildItem "$root\app" -Recurse -File | ForEach-Object { $_.FullName.Substring("$root\app\".Length) })
  Check "installed file set matches payload ($($installed.Count) files)" { -not (Compare-Object ($entries | Where-Object { $_ -notmatch '\\$' }) $installed) }
  Check 'no .git / installer in installed app' { -not (Get-ChildItem "$root\app" -Recurse -Force | Where-Object { $_.Name -in '.git', 'installer', '.ballast' }) }
  Check 'launcher, uninstaller, icon, manifest in install root' { @('launch.ps1', 'uninstall.ps1', 'hidden.vbs', 'ballast.ico', 'version.txt', 'install.json') | ForEach-Object { Test-Path "$root\$_" } | Where-Object { -not $_ } | Measure-Object | ForEach-Object { $_.Count -eq 0 } }
  $lnks = @("$sc\StartMenu\Ballast\Ballast.lnk", "$sc\Desktop\Ballast.lnk", "$sc\StartMenu\Ballast\Stop Ballast.lnk", "$sc\StartMenu\Ballast\Uninstall Ballast.lnk")
  Check 'Start menu (Ballast, Stop, Uninstall) + desktop shortcuts created' { -not ($lnks | Where-Object { -not (Test-Path $_) }) }
  $sh = New-Object -ComObject WScript.Shell
  $l = $sh.CreateShortcut($lnks[0])
  Write-Host "  Ballast.lnk -> $($l.TargetPath) $($l.Arguments) | icon $($l.IconLocation)"
  Check 'Ballast.lnk runs launch.ps1 hidden, with ballast.ico' { $l.TargetPath -match 'wscript\.exe$|powershell\.exe$' -and $l.Arguments -match 'launch\.ps1' -and $l.IconLocation -like "*ballast.ico*" }
  $u = $sh.CreateShortcut($lnks[3])
  Check 'Uninstall Ballast.lnk runs uninstall.ps1' { $u.Arguments -match 'uninstall\.ps1' }
  $rk = Get-ItemProperty $reg
  Write-Host "  UninstallString: $($rk.UninstallString)"
  Check 'Apps & features entry (test key) has name, version, uninstall strings' { $rk.DisplayName -eq 'Ballast' -and $rk.DisplayVersion -eq (Get-Content "$extract\version.txt" -Raw).Trim() -and $rk.UninstallString -match 'uninstall\.ps1' -and $rk.QuietUninstallString -match '-Quiet$' -and $rk.EstimatedSize -gt 0 }
  Check 'real Start menu / desktop / Apps & features untouched' { (Test-Path $realReg) -eq $before.reg -and (Test-Path $realStart) -eq $before.start -and (Test-Path $realDesk) -eq $before.desk }
  Check 'test data folder untouched' { (Get-Content "$dataHome\marker.txt") -eq 'test data' }

  # 4. Upgrade in place.
  Set-Content "$root\app\src\zz-stale.mjs" '// stale'
  Set-Content "$root\logs\keep.txt" 'log'
  $c = Run-PS $installer @('-Quiet', '-NoLaunch', '-SkipPrereqs', '-InstallRoot', $root, '-ShortcutRoot', $sc, '-RegistryKey', $reg, '-LogPath', $log)
  Check 'upgrade exit 0, recognised as an update' { $c -eq 0 -and (Select-String -Path $log -Pattern 'Update Ballast from' -Quiet) }
  Check 'upgrade removed files that no longer ship, kept logs\' { -not (Test-Path "$root\app\src\zz-stale.mjs") -and (Test-Path "$root\logs\keep.txt") -and (Test-Path "$root\app\src\server.mjs") }

  # 5. Launcher on the test port.
  if (-not $SkipLaunch) {
    if (Test-Up $TestPort) { throw "Port $TestPort is already in use; pick another with -TestPort" }
    $realUp = Test-Up 4477
    $wscript = Join-Path $env:windir 'System32\wscript.exe'
    Start-Process -FilePath $wscript -ArgumentList "`"$root\hidden.vbs`" launch.ps1 -Port $TestPort -NoBrowser -Quiet"
    $up = Wait-For { Test-Up $TestPort } 60
    Check "launcher (via hidden.vbs) starts Ballast on $TestPort" { $up }
    $procs = @(Get-TestNode)
    Check 'exactly one node process from the test install' { $procs.Count -eq 1 }
    Check 'node has no visible window' { $procs.Count -eq 1 -and (Get-Process -Id $procs[0].ProcessId).MainWindowHandle -eq [IntPtr]::Zero }
    Write-Host "  node cmdline: $($procs[0].CommandLine)"
    Check 'it used the test BALLAST_HOME (state.json there)' { Wait-For { Test-Path "$dataHome\state.json" } 10 }
    $page = (New-Object System.Net.WebClient).DownloadString("http://127.0.0.1:$TestPort/")
    Check 'serves the Ballast UI' { $page -match '<html' }
    Start-Process -FilePath $wscript -ArgumentList "`"$root\hidden.vbs`" launch.ps1 -Port $TestPort -NoBrowser -Quiet"
    $seen = Wait-For { (Get-Content "$root\logs\launcher.log" -Raw) -match 'Already running' } 20
    Check 'second launch detects it is running and starts no second copy' { $seen -and @(Get-TestNode).Count -eq 1 }
    $c = Run-PS "$root\launch.ps1" @('-Stop', '-Port', $TestPort, '-Quiet')
    $down = Wait-For { -not (Test-Up $TestPort) -and @(Get-TestNode).Count -eq 0 } 15
    Check 'launch.ps1 -Stop stops it' { $c -eq 0 -and $down }
    Check 'the real Ballast on 4477 is unaffected' { (Test-Up 4477) -eq $realUp }
  }

  # 6. Uninstall through the registered QuietUninstallString (keeps data).
  $q = (Get-ItemProperty $reg).QuietUninstallString
  Start-Process -FilePath 'cmd.exe' -ArgumentList "/d /c `"$q`"" -WindowStyle Hidden -Wait
  $gone = Wait-For { -not (Test-Path $root) } 30
  Check 'uninstall removed the install folder' { $gone }
  Check 'uninstall removed shortcuts and the Start menu folder' { -not ($lnks | Where-Object { Test-Path $_ }) -and -not (Test-Path "$sc\StartMenu\Ballast") }
  Check 'uninstall removed the Apps & features entry' { -not (Test-Path $reg) }
  Check 'uninstall kept the data folder' { (Test-Path "$dataHome\marker.txt") }

  # 7. Reinstall, then uninstall with -DeleteData.
  $c = Run-PS $installer @('-Quiet', '-NoLaunch', '-SkipPrereqs', '-InstallRoot', $root, '-ShortcutRoot', $sc, '-RegistryKey', $reg, '-LogPath', $log)
  $c2 = Run-PS "$root\uninstall.ps1" @('-Quiet', '-DeleteData')
  Check 'reinstall + uninstall -DeleteData removes app and data' { $c -eq 0 -and $c2 -eq 0 -and -not (Test-Path $root) -and -not (Test-Path $dataHome) -and -not (Test-Path $reg) }
  Check 'real Start menu / desktop / Apps & features still untouched' { (Test-Path $realReg) -eq $before.reg -and (Test-Path $realStart) -eq $before.start -and (Test-Path $realDesk) -eq $before.desk }
} finally {
  Get-TestNode | ForEach-Object { & taskkill.exe /PID $_.ProcessId /T /F | Out-Null }
  if (Test-Path $regBase) { Remove-Item $regBase -Recurse -Force }
  if ($chainRoot -and (Test-Path $chainRoot)) { Remove-Item -LiteralPath $chainRoot -Recurse -Force -ErrorAction SilentlyContinue }
  $ul = Join-Path $env:TEMP 'BallastUninstall.log'
  if (-not $before.unlog -and (Test-Path $ul)) { Remove-Item $ul -Force }
  if ($KeepTemp) { Write-Host "Kept $t" } else { Start-Sleep -Milliseconds 500; Remove-Item -LiteralPath $t -Recurse -Force -ErrorAction SilentlyContinue }
}
$fails = @($results | Where-Object Result -eq 'FAIL').Count
Write-Host ("`n{0} checks, {1} failed" -f $results.Count, $fails)
exit $(if ($fails) { 1 } else { 0 })
