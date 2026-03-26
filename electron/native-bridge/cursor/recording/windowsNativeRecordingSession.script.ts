export function parseWindowHandleFromSourceId(sourceId?: string | null) {
	if (!sourceId?.startsWith("window:")) {
		return null;
	}

	const handlePart = sourceId.split(":")[1];
	if (!handlePart || !/^\d+$/.test(handlePart)) {
		return null;
	}

	return handlePart;
}

export function buildPowerShellCommand(sampleIntervalMs: number, windowHandle?: string | null) {
	const script = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$targetWindowHandle = ${windowHandle ? `'${windowHandle}'` : '$null'}

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

function Write-JsonLine($payload) {
    [Console]::Out.WriteLine(($payload | ConvertTo-Json -Compress -Depth 6))
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
            $bitmap.Save($memoryStream, [System.Drawing.Imaging.ImageFormat]::Png)
            $base64 = [System.Convert]::ToBase64String($memoryStream.ToArray())

            return @{
                id = $cursorId
                imageDataUrl = "data:image/png;base64,$base64"
                width = $bitmap.Width
                height = $bitmap.Height
                hotspotX = if ($hasIconInfo) { $iconInfo.xHotspot } else { 0 }
                hotspotY = if ($hasIconInfo) { $iconInfo.yHotspot } else { 0 }
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
    $asset = $null

    if ($visible -and $cursorId -and $cursorId -ne $lastCursorId) {
        $asset = Get-CursorAsset -cursorHandle $cursorInfo.hCursor -cursorId $cursorId
        $lastCursorId = $cursorId
    }

    Write-JsonLine @{
        type = 'sample'
        timestampMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        x = $cursorInfo.ptScreenPos.X
        y = $cursorInfo.ptScreenPos.Y
        visible = $visible
        handle = $cursorId
		bounds = Get-TargetBounds
        asset = $asset
    }

    Start-Sleep -Milliseconds ${sampleIntervalMs}
}
`;

	return Buffer.from(script, "utf16le").toString("base64");
}
