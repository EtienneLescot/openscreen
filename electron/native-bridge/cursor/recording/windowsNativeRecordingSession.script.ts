export function buildPowerShellCommand(sampleIntervalMs: number, windowHandle?: string | null) {
	const targetWindowHandle =
		typeof windowHandle === "string" && /^(?:0x[0-9a-fA-F]+|\d+)$/.test(windowHandle)
			? `'${windowHandle}'`
			: "$null";
	const script = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$targetWindowHandle = ${targetWindowHandle}

$source = @"
using System;
using System.Runtime.InteropServices;

public static class OpenScreenCursorInterop {
    [StructLayout(LayoutKind.Sequential)]
    public struct POINT {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct CURSORINFO {
        public int cbSize;
        public int flags;
        public IntPtr hCursor;
        public POINT ptScreenPos;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct ICONINFO {
        [MarshalAs(UnmanagedType.Bool)]
        public bool fIcon;
        public int xHotspot;
        public int yHotspot;
        public IntPtr hbmMask;
        public IntPtr hbmColor;
    }

	[StructLayout(LayoutKind.Sequential)]
	public struct RECT {
		public int Left;
		public int Top;
		public int Right;
		public int Bottom;
	}

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetCursorInfo(ref CURSORINFO pci);

	[DllImport("user32.dll", SetLastError = true)]
	public static extern IntPtr LoadCursor(IntPtr hInstance, IntPtr lpCursorName);

	[DllImport("user32.dll", SetLastError = true)]
	[return: MarshalAs(UnmanagedType.Bool)]
	public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

	[DllImport("user32.dll", SetLastError = true)]
	[return: MarshalAs(UnmanagedType.Bool)]
	public static extern bool IsWindow(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr CopyIcon(IntPtr hIcon);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool DestroyIcon(IntPtr hIcon);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetIconInfo(IntPtr hIcon, out ICONINFO piconinfo);

    [DllImport("gdi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool DeleteObject(IntPtr hObject);
}
"@

Add-Type -TypeDefinition $source

$standardCursors = @{
    arrow = [OpenScreenCursorInterop]::LoadCursor([IntPtr]::Zero, [IntPtr]::new(32512))
    text = [OpenScreenCursorInterop]::LoadCursor([IntPtr]::Zero, [IntPtr]::new(32513))
    wait = [OpenScreenCursorInterop]::LoadCursor([IntPtr]::Zero, [IntPtr]::new(32514))
    crosshair = [OpenScreenCursorInterop]::LoadCursor([IntPtr]::Zero, [IntPtr]::new(32515))
    'up-arrow' = [OpenScreenCursorInterop]::LoadCursor([IntPtr]::Zero, [IntPtr]::new(32516))
    'resize-nwse' = [OpenScreenCursorInterop]::LoadCursor([IntPtr]::Zero, [IntPtr]::new(32642))
    'resize-nesw' = [OpenScreenCursorInterop]::LoadCursor([IntPtr]::Zero, [IntPtr]::new(32643))
    'resize-ew' = [OpenScreenCursorInterop]::LoadCursor([IntPtr]::Zero, [IntPtr]::new(32644))
    'resize-ns' = [OpenScreenCursorInterop]::LoadCursor([IntPtr]::Zero, [IntPtr]::new(32645))
    move = [OpenScreenCursorInterop]::LoadCursor([IntPtr]::Zero, [IntPtr]::new(32646))
    'not-allowed' = [OpenScreenCursorInterop]::LoadCursor([IntPtr]::Zero, [IntPtr]::new(32648))
    pointer = [OpenScreenCursorInterop]::LoadCursor([IntPtr]::Zero, [IntPtr]::new(32649))
    'app-starting' = [OpenScreenCursorInterop]::LoadCursor([IntPtr]::Zero, [IntPtr]::new(32650))
    help = [OpenScreenCursorInterop]::LoadCursor([IntPtr]::Zero, [IntPtr]::new(32651))
}

function Get-StandardCursorType($cursorHandle) {
    if ($cursorHandle -eq [IntPtr]::Zero) {
        return $null
    }

    foreach ($entry in $standardCursors.GetEnumerator()) {
        if ($entry.Value -eq $cursorHandle) {
            return $entry.Key
        }
    }

    return $null
}

function Write-JsonLine($payload) {
    [Console]::Out.WriteLine(($payload | ConvertTo-Json -Compress -Depth 6))
}

function Get-CustomCursorType($bitmap, $hotspotX, $hotspotY) {
    if ($bitmap.Width -lt 24 -or $bitmap.Height -lt 24 -or $bitmap.Width -gt 64 -or $bitmap.Height -gt 64) {
        return $null
    }

    if ($hotspotX -lt ($bitmap.Width * 0.25) -or $hotspotX -gt ($bitmap.Width * 0.75) -or
        $hotspotY -lt ($bitmap.Height * 0.15) -or $hotspotY -gt ($bitmap.Height * 0.55)) {
        return $null
    }

    $opaquePixels = 0
    $topHalfOpaquePixels = 0
    $left = $bitmap.Width
    $top = $bitmap.Height
    $right = -1
    $bottom = -1

    for ($y = 0; $y -lt $bitmap.Height; $y++) {
        for ($x = 0; $x -lt $bitmap.Width; $x++) {
            if ($bitmap.GetPixel($x, $y).A -le 32) {
                continue
            }

            $opaquePixels += 1
            if ($y -lt ($bitmap.Height / 2)) {
                $topHalfOpaquePixels += 1
            }
            if ($x -lt $left) { $left = $x }
            if ($x -gt $right) { $right = $x }
            if ($y -lt $top) { $top = $y }
            if ($y -gt $bottom) { $bottom = $y }
        }
    }

    if ($opaquePixels -lt 90 -or $right -lt $left -or $bottom -lt $top) {
        return $null
    }

    $opaqueWidth = $right - $left + 1
    $opaqueHeight = $bottom - $top + 1
    if ($opaqueWidth -lt ($bitmap.Width * 0.35) -or $opaqueWidth -gt ($bitmap.Width * 0.9) -or
        $opaqueHeight -lt ($bitmap.Height * 0.45) -or $opaqueHeight -gt $bitmap.Height) {
        return $null
    }

    if ($top -gt ($bitmap.Height * 0.45) -or $bottom -lt ($bitmap.Height * 0.65)) {
        return $null
    }

    if ($topHalfOpaquePixels -gt ($opaquePixels * 0.55)) {
        return 'closed-hand'
    }

    return 'open-hand'
}

function Get-TargetBounds() {
	if ([string]::IsNullOrWhiteSpace($targetWindowHandle)) {
		return $null
	}

	try {
		$handleValue = [int64]::Parse($targetWindowHandle)
		$windowHandle = [IntPtr]::new($handleValue)
		if (-not [OpenScreenCursorInterop]::IsWindow($windowHandle)) {
			return $null
		}

		$rect = New-Object OpenScreenCursorInterop+RECT
		if (-not [OpenScreenCursorInterop]::GetWindowRect($windowHandle, [ref]$rect)) {
			return $null
		}

		$width = $rect.Right - $rect.Left
		$height = $rect.Bottom - $rect.Top
		if ($width -le 0 -or $height -le 0) {
			return $null
		}

		return @{
			x = $rect.Left
			y = $rect.Top
			width = $width
			height = $height
		}
	}
	catch {
		return $null
	}
}

function Get-CursorAsset($cursorHandle, $cursorId) {
    $copiedHandle = [OpenScreenCursorInterop]::CopyIcon($cursorHandle)
    if ($copiedHandle -eq [IntPtr]::Zero) {
        return $null
    }

    $iconInfo = New-Object OpenScreenCursorInterop+ICONINFO
    $hasIconInfo = [OpenScreenCursorInterop]::GetIconInfo($copiedHandle, [ref]$iconInfo)

    try {
        $icon = [System.Drawing.Icon]::FromHandle($copiedHandle)
        $bitmap = New-Object System.Drawing.Bitmap $icon.Width, $icon.Height, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $memoryStream = New-Object System.IO.MemoryStream

        try {
            $graphics.Clear([System.Drawing.Color]::Transparent)
            $graphics.DrawIcon($icon, 0, 0)
            $hotspotX = if ($hasIconInfo) { $iconInfo.xHotspot } else { 0 }
            $hotspotY = if ($hasIconInfo) { $iconInfo.yHotspot } else { 0 }
            $customCursorType = Get-CustomCursorType -bitmap $bitmap -hotspotX $hotspotX -hotspotY $hotspotY
            $bitmap.Save($memoryStream, [System.Drawing.Imaging.ImageFormat]::Png)
            $base64 = [System.Convert]::ToBase64String($memoryStream.ToArray())

            return @{
                id = $cursorId
                imageDataUrl = "data:image/png;base64,$base64"
                width = $bitmap.Width
                height = $bitmap.Height
                hotspotX = $hotspotX
                hotspotY = $hotspotY
                cursorType = $customCursorType
            }
        }
        finally {
            $memoryStream.Dispose()
            $graphics.Dispose()
            $bitmap.Dispose()
            $icon.Dispose()
        }
    }
    finally {
        if ($hasIconInfo) {
            if ($iconInfo.hbmMask -ne [IntPtr]::Zero) {
                [OpenScreenCursorInterop]::DeleteObject($iconInfo.hbmMask) | Out-Null
            }
            if ($iconInfo.hbmColor -ne [IntPtr]::Zero) {
                [OpenScreenCursorInterop]::DeleteObject($iconInfo.hbmColor) | Out-Null
            }
        }
        [OpenScreenCursorInterop]::DestroyIcon($copiedHandle) | Out-Null
    }
}

Write-JsonLine @{ type = 'ready'; timestampMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }

$lastCursorId = $null
while ($true) {
    $cursorInfo = New-Object OpenScreenCursorInterop+CURSORINFO
    $cursorInfo.cbSize = [Runtime.InteropServices.Marshal]::SizeOf([type][OpenScreenCursorInterop+CURSORINFO])

    if (-not [OpenScreenCursorInterop]::GetCursorInfo([ref]$cursorInfo)) {
        Write-JsonLine @{ type = 'error'; timestampMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); message = 'GetCursorInfo failed' }
        Start-Sleep -Milliseconds ${sampleIntervalMs}
        continue
    }

    $visible = ($cursorInfo.flags -band 1) -ne 0
    $cursorId = if ($cursorInfo.hCursor -eq [IntPtr]::Zero) { $null } else { ('0x{0:X}' -f $cursorInfo.hCursor.ToInt64()) }
    $cursorType = Get-StandardCursorType $cursorInfo.hCursor
    $asset = $null

    if ($visible -and $cursorId -and $cursorId -ne $lastCursorId) {
        $asset = Get-CursorAsset -cursorHandle $cursorInfo.hCursor -cursorId $cursorId
        if ($asset -and $cursorType) {
            $asset.cursorType = $cursorType
        } elseif ($asset -and $asset.cursorType) {
            $cursorType = $asset.cursorType
        }
        $lastCursorId = $cursorId
    }

    Write-JsonLine @{
        type = 'sample'
        timestampMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        x = $cursorInfo.ptScreenPos.X
        y = $cursorInfo.ptScreenPos.Y
        visible = $visible
        handle = $cursorId
        cursorType = $cursorType
		bounds = Get-TargetBounds
        asset = $asset
    }

    Start-Sleep -Milliseconds ${sampleIntervalMs}
}
`;

	return Buffer.from(script, "utf16le").toString("base64");
}
