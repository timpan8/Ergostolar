# Skalar ned en bild till högst $Max px på längsta sidan och sparar den som JPEG (används av run.mjs för stolsfoton).
# GDI+ först (JPEG, PNG, GIF, BMP; genomskinligt blir vitt). Klarar inte GDI+ bilden (t.ex. WebP) används Windows
# bildkodare (WIC via WPF), som läser WebP med Windows inbyggda WebP-tillägg.
param([Parameter(Mandatory)][string]$Src, [Parameter(Mandatory)][string]$Dst, [int]$Max = 600, [int]$Quality = 82)
$ErrorActionPreference = 'Stop'

function Save-Gdi {
  Add-Type -AssemblyName System.Drawing
  $img = [System.Drawing.Image]::FromFile($Src)
  try {
    $f = [Math]::Min(1.0, $Max / [Math]::Max($img.Width, $img.Height))
    $w = [int][Math]::Round($img.Width * $f); $h = [int][Math]::Round($img.Height * $f)
    $bmp = New-Object System.Drawing.Bitmap $w, $h
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.Clear([System.Drawing.Color]::White)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.DrawImage($img, 0, 0, $w, $h)
    $g.Dispose()
    $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object MimeType -eq 'image/jpeg'
    $p = New-Object System.Drawing.Imaging.EncoderParameters 1
    $p.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), ([long]$Quality)
    $bmp.Save($Dst, $codec, $p)
    $bmp.Dispose()
  } finally { $img.Dispose() }
}

function Save-Wic {
  Add-Type -AssemblyName PresentationCore
  $in = [System.IO.File]::OpenRead($Src)
  try {
    $frame = [System.Windows.Media.Imaging.BitmapDecoder]::Create($in, 'PreservePixelFormat', 'OnLoad').Frames[0]
    $f = [Math]::Min(1.0, $Max / [Math]::Max($frame.PixelWidth, $frame.PixelHeight))
    $scaled = New-Object System.Windows.Media.Imaging.TransformedBitmap $frame, (New-Object System.Windows.Media.ScaleTransform $f, $f)
    # Rita på vit bakgrund så att genomskinliga delar inte blir svarta i JPEG
    $w = $scaled.PixelWidth; $h = $scaled.PixelHeight
    $dv = New-Object System.Windows.Media.DrawingVisual
    $dc = $dv.RenderOpen()
    $dc.DrawRectangle([System.Windows.Media.Brushes]::White, $null, (New-Object System.Windows.Rect 0, 0, $w, $h))
    $dc.DrawImage($scaled, (New-Object System.Windows.Rect 0, 0, $w, $h))
    $dc.Close()
    $rt = New-Object System.Windows.Media.Imaging.RenderTargetBitmap $w, $h, 96, 96, ([System.Windows.Media.PixelFormats]::Pbgra32)
    $rt.Render($dv)
    $enc = New-Object System.Windows.Media.Imaging.JpegBitmapEncoder
    $enc.QualityLevel = $Quality
    $enc.Frames.Add([System.Windows.Media.Imaging.BitmapFrame]::Create($rt))
    $out = [System.IO.File]::Create($Dst)
    try { $enc.Save($out) } finally { $out.Dispose() }
  } finally { $in.Dispose() }
}

try { Save-Gdi } catch { Save-Wic }
