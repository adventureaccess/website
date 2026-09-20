<#
.SYNOPSIS
    Prepares new photographs for the Adventure Access website and the photo index.

.DESCRIPTION
    For each image in -Source this script writes:

      public/images/<Year>/<Month>/<slug>.jpg          a web master, max 2400px, q82
      public/images/resp/<slug>-800.jpg                \
      public/images/resp/<slug>-1400.jpg                >  the widths src/utils/resp.ts expects
      public/images/resp/<slug>-2000.jpg               /

    and prints a tab-separated row per image, ready to paste into the
    "Adventure Access - Photo Index" sheet.

    The camera original is NOT copied into the repo. Git keeps every version of
    every file forever, so a folder of 12 MB originals bloats the clone
    permanently and can never be removed without rewriting history. Originals
    belong in the Drive Footage Bank; the repo gets a web master.

    Uses only .NET, which ships with Windows: System.Drawing for JPEG and PNG,
    and WIC (via WPF's BitmapDecoder) for HEIC, because System.Drawing has no
    HEIC decoder. No ImageMagick, no installs, no native commands - which also
    sidesteps the PowerShell 5.1 habit of carrying on after a native command
    fails.

.PARAMETER Source
    Folder of new photographs: .jpg .jpeg .png .heic .heif.

    HEIC needs Microsoft's free "HEIF Image Extensions" from the Store. The
    script checks for it on the first HEIC file and tells you if it is missing.

.PARAMETER RepoRoot
    The Astro project root - the folder containing public/ and src/.
    Defaults to the script's own folder.

.PARAMETER Year
    Year folder under public/images/. Defaults to the current year.

.PARAMETER Month
    Two-digit month folder. Defaults to the current month.

.PARAMETER Force
    Overwrite files that already exist. Off by default, so a re-run is safe.

.PARAMETER DryRun
    Report what would be written without writing anything.

.EXAMPLE
    .\add-photos.ps1 -Source .\_incoming\bhutan

.EXAMPLE
    .\add-photos.ps1 -Source .\_incoming\nepal -Year 2026 -Month 09 -DryRun

.NOTES
    NAMING. Camera filenames (IMG_5722.JPG) are useless in an index and are how
    a proposal for 65-85 year olds ended up with a 900 m climb as its hero image.
    Put a names.csv in the source folder to give each file a real slug:

        file,slug
        IMG_5722.JPG,khotokha-crane-pair-wetland
        IMG_5880.JPG,paro-valley-morning-mist

    Any file not listed gets its existing basename slugified, and the script
    says so.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $Source,

    [string] $RepoRoot = $PSScriptRoot,

    [string] $Year  = (Get-Date -Format 'yyyy'),

    [ValidatePattern('^\d{2}$')]
    [string] $Month = (Get-Date -Format 'MM'),

    [switch] $Force,

    [switch] $DryRun
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
# WIC, for HEIC. System.Drawing cannot decode it at all.
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase

# resp.ts builds its srcset by convention from these three widths.
# Changing them here means changing WIDTHS in src/utils/resp.ts too.
$RespWidths   = @(800, 1400, 2000)
$RespQuality  = 78
$MasterWidth  = 2400
$MasterQuality = 82

# ---------------------------------------------------------------- helpers

function ConvertTo-Slug {
    param([string] $Text)
    $s = $Text.ToLowerInvariant()
    $s = $s -replace '[^a-z0-9]+', '-'
    $s = $s -replace '^-+|-+$', ''
    if ([string]::IsNullOrWhiteSpace($s)) { $s = 'image' }
    return $s
}

function Get-JpegEncoder {
    [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |
        Where-Object { $_.MimeType -eq 'image/jpeg' } |
        Select-Object -First 1
}

# Cameras record rotation in EXIF rather than rotating the pixels. System.Drawing
# ignores that, so a portrait frame comes out on its side unless we apply it
# ourselves and then drop the tag.
function Set-ExifOrientation {
    param([System.Drawing.Image] $Image)

    $ORIENTATION_TAG = 274
    if ($Image.PropertyIdList -notcontains $ORIENTATION_TAG) { return }

    $value = $Image.GetPropertyItem($ORIENTATION_TAG).Value[0]
    switch ($value) {
        2 { $Image.RotateFlip([System.Drawing.RotateFlipType]::RotateNoneFlipX) }
        3 { $Image.RotateFlip([System.Drawing.RotateFlipType]::Rotate180FlipNone) }
        4 { $Image.RotateFlip([System.Drawing.RotateFlipType]::Rotate180FlipX) }
        5 { $Image.RotateFlip([System.Drawing.RotateFlipType]::Rotate90FlipX) }
        6 { $Image.RotateFlip([System.Drawing.RotateFlipType]::Rotate90FlipNone) }
        7 { $Image.RotateFlip([System.Drawing.RotateFlipType]::Rotate270FlipX) }
        8 { $Image.RotateFlip([System.Drawing.RotateFlipType]::Rotate270FlipNone) }
        default { return }
    }
    $Image.RemovePropertyItem($ORIENTATION_TAG)
}

# System.Drawing has no HEIC decoder and never will. Windows itself can read
# HEIC through WIC once Microsoft's free "HEIF Image Extensions" is installed,
# and WPF's BitmapDecoder is the shortest route to WIC from PowerShell. Decode
# there, re-encode to an in-memory BMP, and hand back an ordinary
# System.Drawing.Bitmap so the rest of the script neither knows nor cares.
function ConvertFrom-Heic {
    param([string] $Path)

    $stream = [System.IO.File]::OpenRead($Path)
    try {
        $decoder = [System.Windows.Media.Imaging.BitmapDecoder]::Create(
            $stream,
            [System.Windows.Media.Imaging.BitmapCreateOptions]::PreservePixelFormat,
            [System.Windows.Media.Imaging.BitmapCacheOption]::OnLoad)

        $frame = $decoder.Frames[0]

        # WIC usually applies the HEIF rotation transform itself. If an EXIF
        # orientation survives on top of that, apply it too - but only when the
        # query actually resolves, so we never rotate twice on a guess.
        $rotate = $null
        try {
            $meta = $frame.Metadata
            if ($meta -and $meta.ContainsQuery('/ifd/{ushort=274}')) {
                switch ($meta.GetQuery('/ifd/{ushort=274}')) {
                    3 { $rotate = 180 }
                    6 { $rotate =  90 }
                    8 { $rotate = 270 }
                }
            }
        } catch { }

        if ($rotate) {
            $t = New-Object System.Windows.Media.RotateTransform($rotate)
            $frame = New-Object System.Windows.Media.Imaging.TransformedBitmap($frame, $t)
        }

        $encoder = New-Object System.Windows.Media.Imaging.BmpBitmapEncoder
        $encoder.Frames.Add([System.Windows.Media.Imaging.BitmapFrame]::Create($frame))

        $mem = New-Object System.IO.MemoryStream
        $encoder.Save($mem)
        $mem.Position = 0
        # Copy out: a Bitmap keeps a handle on its stream, and this one is going away.
        $tmp = New-Object System.Drawing.Bitmap($mem)
        try   { return New-Object System.Drawing.Bitmap($tmp) }
        finally { $tmp.Dispose(); $mem.Dispose() }
    }
    finally { $stream.Dispose() }
}

function Open-SourceImage {
    param([System.IO.FileInfo] $File)

    if ($File.Extension -match '^\.(heic|heif)$') {
        try {
            return ConvertFrom-Heic -Path $File.FullName
        }
        catch {
            throw ("HEIC could not be decoded. Windows needs Microsoft's free " +
                   "'HEIF Image Extensions' from the Microsoft Store - search that exact " +
                   "name, install it, and run this again. " +
                   "Failing that, set the iPhone to Settings > Camera > Formats > " +
                   "Most Compatible and re-export as JPEG. (" + $_.Exception.Message + ")")
        }
    }

    $img = [System.Drawing.Image]::FromFile($File.FullName)
    Set-ExifOrientation -Image $img
    return $img
}

function Save-Resized {
    param(
        [System.Drawing.Image] $Image,
        [int]    $TargetWidth,
        [int]    $Quality,
        [string] $OutPath
    )

    # Never upscale past the source, but always produce the file: a missing
    # entry in a srcset is a broken image, which is worse than a soft one.
    $w = [Math]::Min($TargetWidth, $Image.Width)
    $h = [int][Math]::Round($Image.Height * ($w / [double]$Image.Width))

    $bmp = New-Object System.Drawing.Bitmap($w, $h)
    try {
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        try {
            $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
            $g.InterpolationMode  = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $g.SmoothingMode      = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
            $g.PixelOffsetMode    = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
            $g.DrawImage($Image, 0, 0, $w, $h)
        } finally { $g.Dispose() }

        $encoder = Get-JpegEncoder
        $params  = New-Object System.Drawing.Imaging.EncoderParameters(1)
        $params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter(
            [System.Drawing.Imaging.Encoder]::Quality, [int64]$Quality)
        try {
            $bmp.Save($OutPath, $encoder, $params)
        } finally { $params.Dispose() }
    } finally { $bmp.Dispose() }

    return @{ Width = $w; Height = $h }
}

# ---------------------------------------------------------------- setup

if (-not (Test-Path -LiteralPath $Source)) {
    throw "Source folder not found: $Source"
}

$publicImages = Join-Path $RepoRoot 'public\images'
if (-not (Test-Path -LiteralPath $publicImages)) {
    throw "Could not find public\images under '$RepoRoot'. Pass -RepoRoot pointing at the folder that contains public\ and src\."
}

$destDir = Join-Path $publicImages "$Year\$Month"
$respDir = Join-Path $publicImages 'resp'

# Optional slug map
$slugMap = @{}
$namesCsv = Join-Path $Source 'names.csv'
if (Test-Path -LiteralPath $namesCsv) {
    foreach ($row in (Import-Csv -LiteralPath $namesCsv)) {
        if ($row.file -and $row.slug) { $slugMap[$row.file.Trim()] = $row.slug.Trim() }
    }
    Write-Host "names.csv: $($slugMap.Count) slug(s) supplied." -ForegroundColor DarkGray
} else {
    Write-Host "No names.csv in the source folder - falling back to slugified filenames." -ForegroundColor Yellow
}

$files = Get-ChildItem -LiteralPath $Source -File |
         Where-Object { $_.Extension -match '^\.(jpg|jpeg|png|heic|heif)$' } |
         Sort-Object Name
if (-not $files) { throw "No .jpg, .jpeg, .png, .heic or .heif files in $Source" }

Write-Host ""
Write-Host "$($files.Count) image(s) -> images/$Year/$Month/  +  images/resp/" -ForegroundColor Cyan
if ($DryRun) { Write-Host "DRY RUN - nothing will be written." -ForegroundColor Yellow }
Write-Host ""

if (-not $DryRun) {
    New-Item -ItemType Directory -Force -Path $destDir | Out-Null
    New-Item -ItemType Directory -Force -Path $respDir | Out-Null
}

# ---------------------------------------------------------------- work

$indexRows = New-Object System.Collections.Generic.List[string]
$written = 0; $skipped = 0; $warned = 0

foreach ($f in $files) {
    $slug = if ($slugMap.ContainsKey($f.Name)) {
        ConvertTo-Slug $slugMap[$f.Name]
    } else {
        ConvertTo-Slug ([System.IO.Path]::GetFileNameWithoutExtension($f.Name))
    }

    $masterPath = Join-Path $destDir "$slug.jpg"
    if ((Test-Path -LiteralPath $masterPath) -and -not $Force) {
        Write-Host "  skip   $slug  (already exists - use -Force to replace)" -ForegroundColor DarkGray
        $skipped++
        continue
    }

    $img = $null
    try {
        $img = Open-SourceImage -File $f

        $srcW = $img.Width; $srcH = $img.Height
        $note = ''
        if ($srcW -lt 2000) {
            $note = "  <- only ${srcW}px wide, the 2000 variant will be soft"
            $warned++
        }

        if ($DryRun) {
            Write-Host "  would write  $slug.jpg  ($srcW x $srcH)$note" -ForegroundColor Gray
        }
        else {
            $m = Save-Resized -Image $img -TargetWidth $MasterWidth -Quality $MasterQuality -OutPath $masterPath
            foreach ($w in $RespWidths) {
                $respPath = Join-Path $respDir "$slug-$w.jpg"
                [void](Save-Resized -Image $img -TargetWidth $w -Quality $RespQuality -OutPath $respPath)
            }
            $kb = [int]((Get-Item -LiteralPath $masterPath).Length / 1KB)
            $shape = if ($m.Width -ge $m.Height) { 'landscape' } else { 'portrait' }
            Write-Host "  write  $slug.jpg  ($($m.Width) x $($m.Height) $shape, ${kb} KB) + 3 variants$note" -ForegroundColor Green
            $written++

            # id, url, responsive, shows, subject, destination, place, exertion,
            # orientation, hero?, use for, caution, people, px, verified
            $orient = if ($m.Width -ge $m.Height) { 'landscape' } else { 'portrait' }
            $indexRows.Add(($slug,
                "https://adventure-access.com/images/$Year/$Month/$slug.jpg",
                '800/1400/2000',
                '', '', '', '', '',
                $orient,
                '', '', '', '',
                "$($m.Width)x$($m.Height)",
                '') -join "`t")
        }
    }
    catch {
        Write-Warning "  FAILED $($f.Name): $($_.Exception.Message)"
    }
    finally {
        if ($img) { $img.Dispose() }
    }
}

# ---------------------------------------------------------------- report

Write-Host ""
Write-Host "written $written   skipped $skipped   low-resolution warnings $warned" -ForegroundColor Cyan

if ($indexRows.Count -gt 0) {
    $tsvPath = Join-Path $Source 'index-rows.tsv'
    $indexRows | Set-Content -LiteralPath $tsvPath -Encoding UTF8
    Write-Host ""
    Write-Host "Index rows written to: $tsvPath" -ForegroundColor Cyan
    Write-Host "Open it, copy the lines, and paste into the destination tab of the photo index." -ForegroundColor DarkGray
    Write-Host "Only id, url, responsive, orientation and px are filled in. The columns that matter -" -ForegroundColor DarkGray
    Write-Host "what it shows, exertion, caution, people - need someone to look at the photograph." -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "Next:" -ForegroundColor Cyan
Write-Host "  0. Glance at the portrait ones. Rotation on HEIC is handled by Windows and is"
Write-Host "     normally right, but a sideways frame is obvious and worth ten seconds."
Write-Host "  1. git status   - check only the expected files appear"
Write-Host "  2. Commit and push to a branch, review the Netlify deploy preview, then merge to main"
Write-Host "  3. Fill in the index rows"
Write-Host ""
Write-Host "Originals stay in the Drive Footage Bank. They are deliberately not copied here." -ForegroundColor DarkGray
