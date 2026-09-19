Add-Type -AssemblyName System.Drawing
$output = Join-Path $PSScriptRoot '..\assets'
New-Item -ItemType Directory -Path $output -Force | Out-Null

$bitmap = [System.Drawing.Bitmap]::new(256, 256)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.Clear([System.Drawing.Color]::Transparent)
$background = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 26, 23, 24))
$accent = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(255, 255, 113, 18), 11)
$bolt = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 255, 126, 29))
$edge = [System.Drawing.Drawing2D.GraphicsPath]::new()
$edge.AddArc(15, 15, 56, 56, 180, 90)
$edge.AddArc(185, 15, 56, 56, 270, 90)
$edge.AddArc(185, 185, 56, 56, 0, 90)
$edge.AddArc(15, 185, 56, 56, 90, 90)
$edge.CloseFigure()
$graphics.FillPath($background, $edge)
$graphics.DrawPath($accent, $edge)
$points = [System.Drawing.Point[]]@(
  [System.Drawing.Point]::new(142, 40),
  [System.Drawing.Point]::new(76, 136),
  [System.Drawing.Point]::new(122, 136),
  [System.Drawing.Point]::new(106, 216),
  [System.Drawing.Point]::new(183, 113),
  [System.Drawing.Point]::new(136, 113)
)
$graphics.FillPolygon($bolt, $points)

$stream = [System.IO.MemoryStream]::new()
$bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
$png = $stream.ToArray()
[System.IO.File]::WriteAllBytes((Join-Path $output 'skipy.png'), $png)
$ico = [System.IO.MemoryStream]::new()
$writer = [System.IO.BinaryWriter]::new($ico)
$writer.Write([uint16]0)
$writer.Write([uint16]1)
$writer.Write([uint16]1)
$writer.Write([byte]0)
$writer.Write([byte]0)
$writer.Write([byte]0)
$writer.Write([byte]0)
$writer.Write([uint16]1)
$writer.Write([uint16]32)
$writer.Write([uint32]$png.Length)
$writer.Write([uint32]22)
$writer.Write($png)
[System.IO.File]::WriteAllBytes((Join-Path $output 'skipy.ico'), $ico.ToArray())
$writer.Dispose()
$ico.Dispose()
$stream.Dispose()
$edge.Dispose()
$bolt.Dispose()
$accent.Dispose()
$background.Dispose()
$graphics.Dispose()
$bitmap.Dispose()
