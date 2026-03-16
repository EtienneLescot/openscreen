import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { type Rectangle, screen } from "electron";
import type {
	CursorRecordingData,
	CursorRecordingSample,
	NativeCursorAsset,
} from "../../../../src/native/contracts";
import type { CursorRecordingSession } from "./session";

interface WindowsCursorSampleEvent {
	type: "sample";
	timestampMs: number;
	x: number;
	y: number;
	visible: boolean;
	handle: string | null;
	asset?: WindowsCursorAssetPayload;
}

interface WindowsCursorReadyEvent {
	type: "ready";
	timestampMs: number;
}

interface WindowsCursorErrorEvent {
	type: "error";
	timestampMs: number;
	message: string;
}

interface WindowsCursorAssetPayload {
	id: string;
	imageDataUrl: string;
	width: number;
	height: number;
	hotspotX: number;
	hotspotY: number;
}

type WindowsCursorEvent =
	| WindowsCursorSampleEvent
	| WindowsCursorReadyEvent
	| WindowsCursorErrorEvent;

interface WindowsNativeRecordingSessionOptions {
	getDisplayBounds: () => Rectangle | null;
	maxSamples: number;
	sampleIntervalMs: number;
}

function clamp(value: number, min: number, max: number) {
	return Math.min(max, Math.max(min, value));
}

function buildPowerShellCommand(sampleIntervalMs: number) {
	const script = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

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

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetCursorInfo(ref CURSORINFO pci);

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
        asset = $asset
    }

    Start-Sleep -Milliseconds ${sampleIntervalMs}
}
`;

	return Buffer.from(script, "utf16le").toString("base64");
}

export class WindowsNativeRecordingSession implements CursorRecordingSession {
	private assets = new Map<string, NativeCursorAsset>();
	private samples: CursorRecordingSample[] = [];
	private process: ChildProcessByStdio<null, Readable, Readable> | null = null;
	private lineBuffer = "";
	private startTimeMs = 0;

	constructor(private readonly options: WindowsNativeRecordingSessionOptions) {}

	async start(): Promise<void> {
		this.assets.clear();
		this.samples = [];
		this.lineBuffer = "";
		this.startTimeMs = Date.now();

		const encodedCommand = buildPowerShellCommand(this.options.sampleIntervalMs);
		const child = spawn(
			"powershell.exe",
			[
				"-NoLogo",
				"-NoProfile",
				"-NonInteractive",
				"-ExecutionPolicy",
				"Bypass",
				"-EncodedCommand",
				encodedCommand,
			],
			{
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			},
		);

		this.process = child;
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			this.handleStdoutChunk(chunk);
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			console.error("[cursor-native]", chunk.trim());
		});
	}

	async stop(): Promise<CursorRecordingData> {
		const child = this.process;
		this.process = null;

		if (child && !child.killed) {
			child.kill();
		}

		return {
			version: 2,
			provider: this.assets.size > 0 ? "native" : "none",
			samples: this.samples,
			assets: [...this.assets.values()],
		};
	}

	private handleStdoutChunk(chunk: string) {
		this.lineBuffer += chunk;
		const lines = this.lineBuffer.split(/\r?\n/);
		this.lineBuffer = lines.pop() ?? "";

		for (const line of lines) {
			const trimmedLine = line.trim();
			if (!trimmedLine) {
				continue;
			}

			try {
				const payload = JSON.parse(trimmedLine) as WindowsCursorEvent;
				this.handleEvent(payload);
			} catch (error) {
				console.error("Failed to parse Windows cursor helper output:", error, trimmedLine);
			}
		}
	}

	private handleEvent(payload: WindowsCursorEvent) {
		if (payload.type === "error") {
			console.error("Windows cursor helper error:", payload.message);
			return;
		}

		if (payload.type === "ready") {
			return;
		}

		if (payload.asset?.id && !this.assets.has(payload.asset.id)) {
			const assetDisplay = screen.getDisplayNearestPoint({ x: payload.x, y: payload.y });
			this.assets.set(payload.asset.id, {
				id: payload.asset.id,
				platform: "win32",
				imageDataUrl: payload.asset.imageDataUrl,
				width: payload.asset.width,
				height: payload.asset.height,
				hotspotX: payload.asset.hotspotX,
				hotspotY: payload.asset.hotspotY,
				scaleFactor: assetDisplay.scaleFactor,
			});
		}

		const bounds = this.options.getDisplayBounds() ?? screen.getPrimaryDisplay().bounds;
		const width = Math.max(1, bounds.width);
		const height = Math.max(1, bounds.height);

		this.samples.push({
			timeMs: Math.max(0, payload.timestampMs - this.startTimeMs),
			cx: clamp((payload.x - bounds.x) / width, 0, 1),
			cy: clamp((payload.y - bounds.y) / height, 0, 1),
			assetId: payload.handle,
			visible: payload.visible,
		});

		if (this.samples.length > this.options.maxSamples) {
			this.samples.shift();
		}
	}
}
