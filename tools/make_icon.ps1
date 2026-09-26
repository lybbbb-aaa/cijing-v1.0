# 生成词境应用图标：assets/icon.png + assets/icon.ico（含 16/32/48/256 四种尺寸）
# 用法:  powershell -ExecutionPolicy Bypass -File tools/make_icon.ps1
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$assets = Join-Path $root 'assets'
New-Item -ItemType Directory -Force -Path $assets | Out-Null

function New-IconBitmap([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.TextRenderingHint = 'AntiAliasGridFit'
  $g.Clear([System.Drawing.Color]::Transparent)

  # 背景：深墨绿圆角方块 + 主题绿描边
  $pad = [Math]::Max(1, [int]($size * 0.04))
  $r = [int]($size * 0.22)
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $w = $size - 1 - $pad * 2
  $h = $size - 1 - $pad * 2
  $path.AddArc($pad, $pad, $r, $r, 180, 90)
  $path.AddArc($pad + $w - $r, $pad, $r, $r, 270, 90)
  $path.AddArc($pad + $w - $r, $pad + $h - $r, $r, $r, 0, 90)
  $path.AddArc($pad, $pad + $h - $r, $r, $r, 90, 90)
  $path.CloseFigure()
  $bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    (New-Object System.Drawing.Point(0, 0)),
    (New-Object System.Drawing.Point($size, $size)),
    [System.Drawing.Color]::FromArgb(255, 18, 32, 24),
    [System.Drawing.Color]::FromArgb(255, 42, 96, 68))
  $g.FillPath($bg, $path)

  $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(230, 126, 184, 154), [Math]::Max(1, $size * 0.02))
  $g.DrawPath($pen, $path)

  # 主体字「词」
  $fontSize = $size * 0.52
  $font = New-Object System.Drawing.Font('Microsoft YaHei', $fontSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $fmt = New-Object System.Drawing.StringFormat
  $fmt.Alignment = 'Center'
  $fmt.LineAlignment = 'Center'
  $rect = New-Object System.Drawing.RectangleF(0, [float](-$size * 0.01), $size, $size)
  $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 237, 229, 213))
  $g.DrawString('词', $font, $brush, $rect, $fmt)

  # 右下角强调点（呼应界面里的 logo-dot）
  $dotSize = [int]($size * 0.13)
  $dotX = $size - $pad - $dotSize - [int]($size * 0.1)
  $dotY = $size - $pad - $dotSize - [int]($size * 0.1)
  $dotBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 126, 184, 154))
  $g.FillEllipse($dotBrush, $dotX, $dotY, $dotSize, $dotSize)

  $g.Dispose()
  return $bmp
}

# PNG（256）
$png = New-IconBitmap 256
$png.Save((Join-Path $assets 'icon.png'), [System.Drawing.Imaging.ImageFormat]::Png)
Write-Output ('icon.png  ' + [Math]::Round((Get-Item (Join-Path $assets 'icon.png')).Length / 1024, 1) + ' KB')

# ICO：把多个尺寸的 PNG 拼进一个 ico（Vista+ 支持 PNG 负载）
$sizes = @(16, 32, 48, 256)
$pngBytes = @()
foreach ($s in $sizes) {
  $b = New-IconBitmap $s
  $ms = New-Object System.IO.MemoryStream
  $b.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $pngBytes += , $ms.ToArray()
  $ms.Dispose(); $b.Dispose()
}

$icoPath = Join-Path $assets 'icon.ico'
$fs = [System.IO.File]::Create($icoPath)
$bw = New-Object System.IO.BinaryWriter($fs)
$bw.Write([UInt16]0)                 # reserved
$bw.Write([UInt16]1)                 # type = icon
$bw.Write([UInt16]$sizes.Count)      # count
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $s = $sizes[$i]
  $bw.Write([Byte]$(if ($s -ge 256) { 0 } else { $s }))   # width
  $bw.Write([Byte]$(if ($s -ge 256) { 0 } else { $s }))   # height
  $bw.Write([Byte]0)                 # colors
  $bw.Write([Byte]0)                 # reserved
  $bw.Write([UInt16]1)               # planes
  $bw.Write([UInt16]32)              # bpp
  $bw.Write([UInt32]$pngBytes[$i].Length)
  $bw.Write([UInt32]$offset)
  $offset += $pngBytes[$i].Length
}
foreach ($bytes in $pngBytes) { $bw.Write($bytes) }
$bw.Flush(); $fs.Close()
Write-Output ('icon.ico  ' + [Math]::Round((Get-Item $icoPath).Length / 1024, 1) + ' KB')
