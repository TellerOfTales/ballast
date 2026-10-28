<#
  Builds installer\dist\BallastSetup.exe with IExpress (ships with Windows; nothing is downloaded).

    powershell -NoProfile -ExecutionPolicy Bypass -File installer\build.ps1 [-KeepStage]

  Stages a clean copy of the app (src\, public\, README.md, package.json, LICENSE*; never .git,
  installer\ or anyone's ~\.ballast) as app.zip, adds the install scripts and a generated icon,
  writes a .SED from ballast.sed.template and runs iexpress /N.
#>
param(
  [string]$OutDir = (Join-Path $PSScriptRoot 'dist'),
  [switch]$KeepStage
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$iexpress = Join-Path $env:windir 'System32\iexpress.exe'
if (-not (Test-Path $iexpress)) { throw "IExpress not found at $iexpress" }

# Version: package.json "version", else git describe.
$version = $null
$pkgJson = Join-Path $repo 'package.json'
if (Test-Path $pkgJson) { $version = (Get-Content $pkgJson -Raw | ConvertFrom-Json).version }
if (-not $version) {
  $version = (& git -C $repo describe --always 2>$null | Select-Object -First 1)
  if (-not $version) { $version = '0.0.0' }
}
$version = "$version".Trim()
$nums = @([regex]::Matches($version, '\d+') | Select-Object -First 4 | ForEach-Object { $_.Value })
if ($version -notmatch '^v?\d') { $nums = @() }   # a bare commit hash isn't a version number
while ($nums.Count -lt 4) { $nums += '0' }
$fileVersion = $nums -join '.'
Write-Host "Ballast $version (file version $fileVersion)"

$stage = Join-Path $env:TEMP ('ballast-build-' + [guid]::NewGuid().ToString('N'))
$appStage = Join-Path $stage 'app'
$pkg = Join-Path $stage 'pkg'
New-Item -ItemType Directory -Force -Path $appStage, $pkg, $OutDir | Out-Null

try {
  # 1. Clean copy of the app.
  foreach ($dir in 'src', 'public') {
    $from = Join-Path $repo $dir
    if (-not (Test-Path $from)) { throw "Missing $from" }
    & robocopy.exe $from (Join-Path $appStage $dir) /E /XD .git node_modules .ballast /XF *.log .DS_Store Thumbs.db /R:2 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "Copying $dir failed (robocopy $LASTEXITCODE)" }
  }
  $files = @('README.md', 'package.json') + @(Get-ChildItem -LiteralPath $repo -File -Filter 'LICENSE*' | ForEach-Object Name)
  foreach ($f in $files) {
    $p = Join-Path $repo $f
    if (Test-Path -LiteralPath $p) { Copy-Item -LiteralPath $p -Destination $appStage }
  }
  if (-not (Test-Path (Join-Path $appStage 'src\server.mjs'))) { throw 'src\server.mjs is missing from the staged app' }
  $bad = Get-ChildItem -LiteralPath $appStage -Recurse -Force | Where-Object { $_.Name -in '.git', 'installer', '.ballast', 'node_modules' }
  if ($bad) { throw "Staged app contains excluded items: $($bad.FullName -join ', ')" }

  # 2. Payload: app.zip + install scripts + icon + version.
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::CreateFromDirectory($appStage, (Join-Path $pkg 'app.zip'), [System.IO.Compression.CompressionLevel]::Optimal, $false)
  foreach ($f in 'install.cmd', 'install.ps1', 'uninstall.ps1', 'launch.ps1', 'hidden.vbs') {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $f) -Destination $pkg
  }
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'make-icon.ps1') -OutFile (Join-Path $pkg 'ballast.ico')
  if ($LASTEXITCODE) { throw 'Icon generation failed' }
  [IO.File]::WriteAllText((Join-Path $pkg 'version.txt'), $version)

  # 3. SED + IExpress.
  $target = Join-Path ([IO.Path]::GetFullPath($OutDir)) 'BallastSetup.exe'
  $pkgFiles = @(Get-ChildItem -LiteralPath $pkg -File | Sort-Object Name)
  $strings = ($pkgFiles | ForEach-Object -Begin { $i = 0 } -Process { 'FILE{0}="{1}"' -f $i++, $_.Name }) -join "`r`n"
  $list = (0..($pkgFiles.Count - 1) | ForEach-Object { '%FILE{0}%=' -f $_ }) -join "`r`n"
  $sed = (Get-Content (Join-Path $PSScriptRoot 'ballast.sed.template') -Raw).
    Replace('{{TARGET}}', $target).Replace('{{VERSION}}', $version).Replace('{{FILEVERSION}}', $fileVersion).
    Replace('{{PKGDIR}}', $pkg).Replace('{{FILES_STRINGS}}', $strings).Replace('{{FILES_LIST}}', $list)
  $sedPath = Join-Path $stage 'ballast.sed'
  [IO.File]::WriteAllText($sedPath, ($sed -replace "(?<!`r)`n", "`r`n"), [Text.Encoding]::ASCII)

  if (Test-Path $target) { Remove-Item -LiteralPath $target -Force }
  Write-Host "Running IExpress..."
  # IExpress can't take a quoted SED path, so use the 8.3 name if the path has spaces.
  $sedArg = $sedPath
  if ($sedArg -match ' ') { $sedArg = (New-Object -ComObject Scripting.FileSystemObject).GetFile($sedPath).ShortPath }
  $p = Start-Process -FilePath $iexpress -ArgumentList "/N /Q $sedArg" -Wait -PassThru -WindowStyle Hidden
  if (-not (Test-Path $target)) { $KeepStage = $true; throw "IExpress didn't produce $target (exit code $($p.ExitCode)). SED kept at $sedPath" }
  $size = (Get-Item $target).Length
  Write-Host ("Built {0} ({1:N0} bytes, {2:N1} KB)" -f $target, $size, ($size / 1KB))
  Write-Host ("Payload: " + (($pkgFiles | ForEach-Object { '{0} ({1:N0} B)' -f $_.Name, $_.Length }) -join ', '))
} finally {
  if ($KeepStage) { Write-Host "Stage kept at $stage" }
  elseif (Test-Path $stage) { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue }
}
