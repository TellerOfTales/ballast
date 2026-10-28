<#
  Draws the Ballast icon (public/favicon.svg: gold U over a green half-disc) on a dark
  rounded square with System.Drawing and writes a multi-size .ico (PNG-compressed entries).
  System.Drawing can't render SVG, so the favicon's paths are reproduced here by hand.

    powershell -NoProfile -File make-icon.ps1 -OutFile ballast.ico [-PreviewPng preview.png]
#>
param(
  [Parameter(Mandatory = $true)][string]$OutFile,
  [string]$PreviewPng,
  [int[]]$Sizes = @(16, 20, 24, 32, 40, 48, 64, 128, 256)
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

function New-Color([string]$hex) { [System.Drawing.ColorTranslator]::FromHtml($hex) }
$Gold = New-Color '#e9a820'
$Green = New-Color '#179a48'
$Dark = New-Color '#0e1013'

# Quadratic segment -> cubic, appended to a GraphicsPath. $p0 is the current point.
function Add-Quad($path, [double[]]$p0, [double[]]$c, [double[]]$p2) {
  $c1x = $p0[0] + 2.0 / 3.0 * ($c[0] - $p0[0]); $c1y = $p0[1] + 2.0 / 3.0 * ($c[1] - $p0[1])
  $c2x = $p2[0] + 2.0 / 3.0 * ($c[0] - $p2[0]); $c2y = $p2[1] + 2.0 / 3.0 * ($c[1] - $p2[1])
  $path.AddBezier([single]$p0[0], [single]$p0[1], [single]$c1x, [single]$c1y, [single]$c2x, [single]$c2y, [single]$p2[0], [single]$p2[1])
}

# The two "side" bands of the favicon (<g id="side">), in SVG user units.
function New-SidePath {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  # M62 132H256q6 0 9 6l15 32H86q-30 0-30-30q0-8 6-8z
  $p.StartFigure()
  $p.AddLine(62, 132, 256, 132)
  Add-Quad $p @(256, 132) @(262, 132) @(265, 138)
  $p.AddLine(265, 138, 280, 170)
  $p.AddLine(280, 170, 86, 170)
  Add-Quad $p @(86, 170) @(56, 170) @(56, 140)
  Add-Quad $p @(56, 140) @(56, 132) @(62, 132)
  $p.CloseFigure()
  # M106 180H372l-34 31H200v8h-34q-12 0-16-8l-6-10H122q-16 0-16-14z
  $p.StartFigure()
  $p.AddLine(106, 180, 372, 180)
  $p.AddLine(372, 180, 338, 211)
  $p.AddLine(338, 211, 200, 211)
  $p.AddLine(200, 211, 200, 219)
  $p.AddLine(200, 219, 166, 219)
  Add-Quad $p @(166, 219) @(154, 219) @(150, 211)
  $p.AddLine(150, 211, 144, 201)
  $p.AddLine(144, 201, 122, 201)
  Add-Quad $p @(122, 201) @(106, 201) @(106, 187)
  $p.CloseFigure()
  return $p
}

function New-IconBitmap([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)

  # Dark rounded-square background.
  $r = [Math]::Max(2.0, $size * 0.2)
  $bg = New-Object System.Drawing.Drawing2D.GraphicsPath
  $w = $size - 0.5
  $bg.AddArc(0, 0, $r * 2, $r * 2, 180, 90)
  $bg.AddArc($w - $r * 2, 0, $r * 2, $r * 2, 270, 90)
  $bg.AddArc($w - $r * 2, $w - $r * 2, $r * 2, $r * 2, 0, 90)
  $bg.AddArc(0, $w - $r * 2, $r * 2, $r * 2, 90, 90)
  $bg.CloseFigure()
  $bgBrush = New-Object System.Drawing.SolidBrush($Dark)
  $g.FillPath($bgBrush, $bg)

  # Map the logo's bounds (x 56..1478, y 132..1006 in the favicon's own path units)
  # into the square with some padding; small sizes get less padding and heavier strokes.
  $pad = if ($size -le 24) { 0.06 } elseif ($size -le 48) { 0.1 } else { 0.13 }
  $inner = $size * (1 - 2 * $pad)
  $scale = $inner / (1478 - 56)
  $logoH = (1006 - 132) * $scale
  $g.TranslateTransform([single]($size * $pad), [single](($size - $logoH) / 2))
  $g.ScaleTransform([single]$scale, [single]$scale)
  $g.TranslateTransform(-56, -132)   # now drawing in favicon path units

  $strokeW = 92
  if ($size -le 20) { $strokeW = 150 } elseif ($size -le 32) { $strokeW = 120 } elseif ($size -le 48) { $strokeW = 104 }

  # Green half-disc: M300 560H1234C1170 760 980 880 767 880S364 760 300 560Z
  $disc = New-Object System.Drawing.Drawing2D.GraphicsPath
  $disc.AddLine(300, 560, 1234, 560)
  $disc.AddBezier(1234, 560, 1170, 760, 980, 880, 767, 880)
  $disc.AddBezier(767, 880, 554, 880, 364, 760, 300, 560)
  $disc.CloseFigure()
  $g.FillPath((New-Object System.Drawing.SolidBrush($Green)), $disc)

  # Gold U: M190 205V330C190 720 470 960 767 960S1344 720 1344 330V205 (stroke 92)
  $u = New-Object System.Drawing.Drawing2D.GraphicsPath
  $u.AddLine(190, 205, 190, 330)
  $u.AddBezier(190, 330, 190, 720, 470, 960, 767, 960)
  $u.AddBezier(767, 960, 1064, 960, 1344, 720, 1344, 330)
  $u.AddLine(1344, 330, 1344, 205)
  $pen = New-Object System.Drawing.Pen($Gold, $strokeW)
  $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
  $g.DrawPath($pen, $u)

  # Side bands, left and mirrored right (translate(1534 0) scale(-1 1)). Too fine below 24px.
  if ($size -ge 24) {
    $gold = New-Object System.Drawing.SolidBrush($Gold)
    $left = New-SidePath
    $g.FillPath($gold, $left)
    $right = New-SidePath
    $right.Transform((New-Object System.Drawing.Drawing2D.Matrix(-1, 0, 0, 1, 1534, 0)))
    $g.FillPath($gold, $right)
  }
  $g.Dispose()
  return $bmp
}

$images = @()
foreach ($s in $Sizes) {
  $bmp = New-IconBitmap $s
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $images += , @($s, $ms.ToArray())
  if ($PreviewPng -and $s -eq ($Sizes | Measure-Object -Maximum).Maximum) { $bmp.Save($PreviewPng, [System.Drawing.Imaging.ImageFormat]::Png) }
  $bmp.Dispose()
}

# ICO container: ICONDIR + ICONDIRENTRY[n] + PNG blobs.
$out = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($out)
$bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]$images.Count)
$offset = 6 + 16 * $images.Count
foreach ($img in $images) {
  $s = $img[0]; $data = $img[1]
  $dim = if ($s -ge 256) { 0 } else { $s }
  $bw.Write([byte]$dim); $bw.Write([byte]$dim); $bw.Write([byte]0); $bw.Write([byte]0)
  $bw.Write([UInt16]1); $bw.Write([UInt16]32)
  $bw.Write([UInt32]$data.Length); $bw.Write([UInt32]$offset)
  $offset += $data.Length
}
foreach ($img in $images) { $bw.Write([byte[]]$img[1]) }
$bw.Flush()
[System.IO.File]::WriteAllBytes($OutFile, $out.ToArray())
$bw.Dispose()
Write-Host "Wrote $OutFile ($($images.Count) sizes)"
