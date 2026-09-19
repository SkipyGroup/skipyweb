Add-Type -AssemblyName System.Drawing
$output = Join-Path $PSScriptRoot '..\assets'
New-Item -ItemType Directory -Path $output -Force | Out-Null

$sourcePath = Join-Path $output 'skipy-logo-source.png'
if (-not (Test-Path -LiteralPath $sourcePath)) { throw "Missing logo source: $sourcePath" }
$source = [System.Drawing.Image]::FromFile($sourcePath)
$bitmap = [System.Drawing.Bitmap]::new(256, 256)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$graphics.Clear([System.Drawing.Color]::Transparent)
$graphics.DrawImage($source, [System.Drawing.Rectangle]::new(0, 0, 256, 256))

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
$graphics.Dispose()
$bitmap.Dispose()
$source.Dispose()
