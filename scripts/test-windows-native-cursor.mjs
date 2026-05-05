import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function readPositiveIntEnv(name, fallback) {
	const raw = process.env[name];
	if (raw === undefined) {
		return fallback;
	}

	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		console.warn(`[cursor-native-test] ignoring invalid ${name}=${raw}; using ${fallback}`);
		return fallback;
	}

	return Math.floor(parsed);
}

const SAMPLE_INTERVAL_MS = readPositiveIntEnv("CURSOR_TEST_SAMPLE_INTERVAL_MS", 25);
const DURATION_MS = readPositiveIntEnv("CURSOR_TEST_DURATION_MS", 1800);
const SCREEN_FRAME_INTERVAL_MS = readPositiveIntEnv("CURSOR_TEST_SCREEN_FRAME_INTERVAL_MS", 100);
const READY_TIMEOUT_MS = readPositiveIntEnv("CURSOR_TEST_READY_TIMEOUT_MS", 5000);
const OUTPUT_DIR =
	process.env.CURSOR_TEST_OUTPUT_DIR ??
	path.join(os.tmpdir(), `openscreen-cursor-native-${Date.now()}`);

if (process.platform !== "win32") {
	console.error("This diagnostic is Windows-only.");
	process.exit(1);
}

function encodePowerShell(script) {
	return Buffer.from(script, "utf16le").toString("base64");
}

function quotePowerShellString(value) {
	return `'${String(value).replaceAll("'", "''")}'`;
}

function runPowerShell(script) {
	return new Promise((resolve, reject) => {
		const child = spawn(
			"powershell.exe",
			[
				"-NoLogo",
				"-NoProfile",
				"-NonInteractive",
				"-ExecutionPolicy",
				"Bypass",
				"-EncodedCommand",
				encodePowerShell(script),
			],
			{ stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
		);

		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			if (code === 0) {
				resolve(stdout);
				return;
			}

			reject(
				new Error(`PowerShell command failed (code=${code}, signal=${signal}): ${stderr.trim()}`),
			);
		});
	});
}

function spawnPowerShell(script, { onStdout, onStderr } = {}) {
	const scriptPath = path.join(
		os.tmpdir(),
		`openscreen-powershell-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.ps1`,
	);
	fs.writeFileSync(scriptPath, script, "utf8");
	const child = spawn(
		"powershell.exe",
		["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
		{ stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
	);

	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk) => onStdout?.(chunk));
	child.stderr.on("data", (chunk) => onStderr?.(chunk));

	const done = new Promise((resolve, reject) => {
		const cleanup = () => {
			fs.rmSync(scriptPath, { force: true });
		};
		child.once("error", (error) => {
			cleanup();
			reject(error);
		});
		child.once("exit", (code, signal) => {
			cleanup();
			if (code === 0 || child.killed) {
				resolve({ code, signal });
				return;
			}

			reject(new Error(`PowerShell process failed (code=${code}, signal=${signal})`));
		});
	});

	return { child, done };
}

function buildSamplerScript() {
	return String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

$source = @"
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

public static class OpenScreenCursorDiagnosticInterop {
    private const int WH_MOUSE_LL = 14;
    private const int WM_LBUTTONDOWN = 0x0201;
    private const int WM_LBUTTONUP = 0x0202;
    private static readonly object MouseSync = new object();
    private static int LeftDownCount = 0;
    private static int LeftUpCount = 0;
    private static IntPtr MouseHook = IntPtr.Zero;
    private static LowLevelMouseProc MouseProcDelegate = MouseHookCallback;

    public delegate IntPtr LowLevelMouseProc(int nCode, IntPtr wParam, IntPtr lParam);

    public struct MouseButtonEvents {
        public int LeftDownCount;
        public int LeftUpCount;
    }

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

    public static bool InstallMouseHook() {
        if (MouseHook != IntPtr.Zero) {
            return true;
        }

        using (Process process = Process.GetCurrentProcess())
        using (ProcessModule module = process.MainModule) {
            MouseHook = SetWindowsHookEx(WH_MOUSE_LL, MouseProcDelegate, GetModuleHandle(module.ModuleName), 0);
        }

        return MouseHook != IntPtr.Zero;
    }

    public static MouseButtonEvents ConsumeMouseButtonEvents() {
        lock (MouseSync) {
            MouseButtonEvents events = new MouseButtonEvents {
                LeftDownCount = LeftDownCount,
                LeftUpCount = LeftUpCount
            };
            LeftDownCount = 0;
            LeftUpCount = 0;
            return events;
        }
    }

    private static IntPtr MouseHookCallback(int nCode, IntPtr wParam, IntPtr lParam) {
        if (nCode >= 0) {
            int message = wParam.ToInt32();
            if (message == WM_LBUTTONDOWN || message == WM_LBUTTONUP) {
                lock (MouseSync) {
                    if (message == WM_LBUTTONDOWN) {
                        LeftDownCount += 1;
                    } else {
                        LeftUpCount += 1;
                    }
                }
            }
        }

        return CallNextHookEx(MouseHook, nCode, wParam, lParam);
    }

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetCursorInfo(ref CURSORINFO pci);

    [DllImport("user32.dll")]
    public static extern short GetAsyncKeyState(int vKey);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr LoadCursor(IntPtr hInstance, IntPtr lpCursorName);

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

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelMouseProc lpfn, IntPtr hMod, uint dwThreadId);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    private static extern IntPtr GetModuleHandle(string lpModuleName);
}
"@

Add-Type -TypeDefinition $source

$standardCursors = @{
    arrow = [OpenScreenCursorDiagnosticInterop]::LoadCursor([IntPtr]::Zero, [IntPtr]::new(32512))
    text = [OpenScreenCursorDiagnosticInterop]::LoadCursor([IntPtr]::Zero, [IntPtr]::new(32513))
    wait = [OpenScreenCursorDiagnosticInterop]::LoadCursor([IntPtr]::Zero, [IntPtr]::new(32514))
    crosshair = [OpenScreenCursorDiagnosticInterop]::LoadCursor([IntPtr]::Zero, [IntPtr]::new(32515))
    'up-arrow' = [OpenScreenCursorDiagnosticInterop]::LoadCursor([IntPtr]::Zero, [IntPtr]::new(32516))
    'resize-nwse' = [OpenScreenCursorDiagnosticInterop]::LoadCursor([IntPtr]::Zero, [IntPtr]::new(32642))
    'resize-nesw' = [OpenScreenCursorDiagnosticInterop]::LoadCursor([IntPtr]::Zero, [IntPtr]::new(32643))
    'resize-ew' = [OpenScreenCursorDiagnosticInterop]::LoadCursor([IntPtr]::Zero, [IntPtr]::new(32644))
    'resize-ns' = [OpenScreenCursorDiagnosticInterop]::LoadCursor([IntPtr]::Zero, [IntPtr]::new(32645))
    move = [OpenScreenCursorDiagnosticInterop]::LoadCursor([IntPtr]::Zero, [IntPtr]::new(32646))
    'not-allowed' = [OpenScreenCursorDiagnosticInterop]::LoadCursor([IntPtr]::Zero, [IntPtr]::new(32648))
    pointer = [OpenScreenCursorDiagnosticInterop]::LoadCursor([IntPtr]::Zero, [IntPtr]::new(32649))
    'app-starting' = [OpenScreenCursorDiagnosticInterop]::LoadCursor([IntPtr]::Zero, [IntPtr]::new(32650))
    help = [OpenScreenCursorDiagnosticInterop]::LoadCursor([IntPtr]::Zero, [IntPtr]::new(32651))
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

function Get-CursorAsset($cursorHandle, $cursorId) {
    $copiedHandle = [OpenScreenCursorDiagnosticInterop]::CopyIcon($cursorHandle)
    if ($copiedHandle -eq [IntPtr]::Zero) {
        return $null
    }

    $iconInfo = New-Object OpenScreenCursorDiagnosticInterop+ICONINFO
    $hasIconInfo = [OpenScreenCursorDiagnosticInterop]::GetIconInfo($copiedHandle, [ref]$iconInfo)

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
                [OpenScreenCursorDiagnosticInterop]::DeleteObject($iconInfo.hbmMask) | Out-Null
            }
            if ($iconInfo.hbmColor -ne [IntPtr]::Zero) {
                [OpenScreenCursorDiagnosticInterop]::DeleteObject($iconInfo.hbmColor) | Out-Null
            }
        }
        [OpenScreenCursorDiagnosticInterop]::DestroyIcon($copiedHandle) | Out-Null
    }
}

[OpenScreenCursorDiagnosticInterop]::InstallMouseHook() | Out-Null
[OpenScreenCursorDiagnosticInterop]::GetAsyncKeyState(0x01) | Out-Null
Write-JsonLine @{ type = 'ready'; timestampMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }

$lastCursorId = $null
$screenBounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
while ($true) {
    [System.Windows.Forms.Application]::DoEvents()
    $mouseEvents = [OpenScreenCursorDiagnosticInterop]::ConsumeMouseButtonEvents()
    $cursorInfo = New-Object OpenScreenCursorDiagnosticInterop+CURSORINFO
    $cursorInfo.cbSize = [Runtime.InteropServices.Marshal]::SizeOf([type][OpenScreenCursorDiagnosticInterop+CURSORINFO])

    if (-not [OpenScreenCursorDiagnosticInterop]::GetCursorInfo([ref]$cursorInfo)) {
        Write-JsonLine @{ type = 'error'; timestampMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); message = 'GetCursorInfo failed' }
        Start-Sleep -Milliseconds ${SAMPLE_INTERVAL_MS}
        continue
    }

    $visible = ($cursorInfo.flags -band 1) -ne 0
    $cursorId = if ($cursorInfo.hCursor -eq [IntPtr]::Zero) { $null } else { ('0x{0:X}' -f $cursorInfo.hCursor.ToInt64()) }
    $cursorType = Get-StandardCursorType $cursorInfo.hCursor
    $leftButtonState = [OpenScreenCursorDiagnosticInterop]::GetAsyncKeyState(0x01)
    $leftButtonDown = ($leftButtonState -band 0x8000) -ne 0
    $leftButtonPressed = ($mouseEvents.LeftDownCount -gt 0) -or (($leftButtonState -band 0x0001) -ne 0)
    $leftButtonReleased = $mouseEvents.LeftUpCount -gt 0
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
        leftButtonDown = $leftButtonDown
        leftButtonPressed = $leftButtonPressed
        leftButtonReleased = $leftButtonReleased
        bounds = @{
            x = $screenBounds.Left
            y = $screenBounds.Top
            width = $screenBounds.Width
            height = $screenBounds.Height
        }
        asset = $asset
    }

    Start-Sleep -Milliseconds ${SAMPLE_INTERVAL_MS}
}
`;
}

function buildMousePathScript(durationMs) {
	const stepMs = 120;
	const steps = Math.max(8, Math.floor(durationMs / stepMs));

	return String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms

$source = @"
using System.Runtime.InteropServices;
using System;

public static class OpenScreenMouseDiagnosticInterop {
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetCursorPos(int X, int Y);

    [DllImport("user32.dll")]
    public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
}
"@

Add-Type -TypeDefinition $source

$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$points = @()
for ($i = 0; $i -lt ${steps}; $i++) {
    $t = if (${steps} -le 1) { 0 } else { $i / (${steps} - 1) }
    $x = [int]($bounds.Left + 80 + (($bounds.Width - 160) * $t))
    $wave = [Math]::Sin($t * [Math]::PI * 2)
    $y = [int]($bounds.Top + ($bounds.Height / 2) + ($wave * [Math]::Min(180, $bounds.Height / 4)))
    $points += @{ x = $x; y = $y }
}

for ($i = 0; $i -lt $points.Count; $i++) {
    $point = $points[$i]
    [OpenScreenMouseDiagnosticInterop]::SetCursorPos($point.x, $point.y) | Out-Null
    if ($i -eq [int]([Math]::Floor($points.Count / 2))) {
        [OpenScreenMouseDiagnosticInterop]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 12
        [OpenScreenMouseDiagnosticInterop]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
    }
    Start-Sleep -Milliseconds ${stepMs}
}
`;
}

function buildScreenRecorderScript(outputDir, durationMs) {
	const framesDir = path.join(outputDir, "screen-frames");

	return String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

$framesDir = ${quotePowerShellString(framesDir)}
New-Item -ItemType Directory -Force -Path $framesDir | Out-Null

$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$targetWidth = 960
$targetHeight = [int]([Math]::Round($targetWidth * ($bounds.Height / $bounds.Width)))
$frames = New-Object System.Collections.Generic.List[object]
$stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
$index = 0

while ($stopwatch.ElapsedMilliseconds -le ${durationMs + 700}) {
    $sourceBitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($sourceBitmap)
    $scaledBitmap = New-Object System.Drawing.Bitmap $targetWidth, $targetHeight, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $scaledGraphics = [System.Drawing.Graphics]::FromImage($scaledBitmap)
    $timestampMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $fileName = ('frame_{0:D4}.png' -f $index)
    $path = Join-Path $framesDir $fileName

    try {
        $graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bounds.Size)
        $scaledGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $scaledGraphics.DrawImage($sourceBitmap, 0, 0, $targetWidth, $targetHeight)
        $scaledBitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
        $frames.Add(@{
            index = $index
            timestampMs = $timestampMs
            path = $path
            width = $targetWidth
            height = $targetHeight
            bounds = @{
                x = $bounds.Left
                y = $bounds.Top
                width = $bounds.Width
                height = $bounds.Height
            }
        }) | Out-Null
    }
    finally {
        $scaledGraphics.Dispose()
        $scaledBitmap.Dispose()
        $graphics.Dispose()
        $sourceBitmap.Dispose()
    }

    $index += 1
    Start-Sleep -Milliseconds ${SCREEN_FRAME_INTERVAL_MS}
}

($frames | ConvertTo-Json -Depth 6) | Set-Content -Path (Join-Path $framesDir 'frames.json') -Encoding UTF8
`;
}

function createReadyWaiter() {
	let settled = false;
	let resolveReady = null;
	const promise = new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			if (settled) {
				return;
			}
			settled = true;
			reject(new Error("Timed out waiting for cursor sampler readiness."));
		}, READY_TIMEOUT_MS);

		resolveReady = () => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			resolve();
		};
	});

	return {
		promise,
		resolve: () => resolveReady?.(),
	};
}

function writeAssets(assets, outputDir) {
	const assetDir = path.join(outputDir, "assets");
	fs.mkdirSync(assetDir, { recursive: true });

	for (const asset of assets.values()) {
		const base64 = asset.imageDataUrl?.replace(/^data:image\/png;base64,/, "");
		if (!base64) {
			continue;
		}

		const safeId = String(asset.id).replace(/[^a-zA-Z0-9_-]/g, "_");
		fs.writeFileSync(path.join(assetDir, `${safeId}.png`), Buffer.from(base64, "base64"));
	}
}

function toRecordingData(samples, assets) {
	const firstTimestampMs = samples[0]?.timestampMs ?? Date.now();
	let previousLeftButtonDown = false;
	const normalizedSamples = samples.flatMap((sample) => {
		const bounds = sample.bounds;
		if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
			return [];
		}

		const leftButtonDown = sample.leftButtonDown === true;
		const leftButtonPressed = sample.leftButtonPressed === true;
		const leftButtonReleased = sample.leftButtonReleased === true;
		const interactionType =
			leftButtonPressed || (leftButtonDown && !previousLeftButtonDown)
				? "click"
				: leftButtonReleased || (!leftButtonDown && previousLeftButtonDown)
					? "mouseup"
					: "move";
		previousLeftButtonDown = leftButtonDown;

		return [
			{
				timeMs: Math.max(0, sample.timestampMs - firstTimestampMs),
				cx: (sample.x - bounds.x) / bounds.width,
				cy: (sample.y - bounds.y) / bounds.height,
				assetId: sample.handle,
				visible: Boolean(sample.visible),
				cursorType: sample.cursorType ?? null,
				interactionType,
			},
		];
	});

	return {
		version: 2,
		provider: assets.size > 0 ? "native" : "none",
		samples: normalizedSamples,
		assets: [...assets.values()].map((asset) => ({
			id: asset.id,
			platform: "win32",
			imageDataUrl: asset.imageDataUrl,
			width: asset.width,
			height: asset.height,
			hotspotX: asset.hotspotX,
			hotspotY: asset.hotspotY,
			scaleFactor: 1,
			cursorType: asset.cursorType ?? null,
		})),
	};
}

function escapeScriptJson(value) {
	return JSON.stringify(value).replace(/</g, "\\u003c");
}

function buildVisualReportHtml(report, recordingData) {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OpenScreen native cursor diagnostic</title>
<style>
body { margin: 0; background: #111; color: #eee; font-family: Arial, sans-serif; }
main { max-width: 1180px; margin: 0 auto; padding: 24px; }
h1 { font-size: 22px; margin: 0 0 16px; }
.metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; margin-bottom: 16px; }
.metric { background: #1d1d1d; border: 1px solid #333; padding: 10px; border-radius: 6px; }
.metric b { display: block; color: #9bd; font-size: 20px; }
canvas { width: 100%; height: auto; background: #181818; border: 1px solid #333; border-radius: 6px; }
.assets { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 18px; }
.asset { background: #1d1d1d; border: 1px solid #333; border-radius: 6px; padding: 10px; min-width: 130px; }
.asset img { image-rendering: auto; width: 64px; height: 64px; object-fit: contain; background: repeating-conic-gradient(#444 0 25%, #333 0 50%) 50% / 16px 16px; }
.hint { color: #aaa; font-size: 13px; margin: 10px 0 18px; }
</style>
</head>
<body>
<main>
<h1>OpenScreen native cursor diagnostic</h1>
<div class="metrics">
<div class="metric"><b>${report.sampleCount}</b>samples</div>
<div class="metric"><b>${report.assetCount}</b>assets</div>
<div class="metric"><b>${report.uniquePositionCount}</b>positions</div>
<div class="metric"><b>${report.errorCount}</b>errors</div>
</div>
<p class="hint">The red cross is the captured native hotspot. Native bitmaps are drawn at 1x, 2x, and 3x. The last cursor is a crisp vector 3x replacement anchored on the same hotspot.</p>
<canvas id="preview" width="960" height="540"></canvas>
<section class="assets" id="assets"></section>
</main>
<script id="recording-data" type="application/json">${escapeScriptJson(recordingData)}</script>
<script>
const recording = JSON.parse(document.getElementById("recording-data").textContent);
const canvas = document.getElementById("preview");
const ctx = canvas.getContext("2d");
const durationMs = Math.max(1000, recording.samples.at(-1)?.timeMs ?? 1000);
const images = new Map();

function clamp(value, min, max) {
	return Math.min(max, Math.max(min, value));
}

function loadImages() {
	return Promise.all(recording.assets.map((asset) => new Promise((resolve) => {
		const image = new Image();
		image.onload = () => {
			images.set(asset.id, image);
			resolve();
		};
		image.src = asset.imageDataUrl;
	})));
}

function frameAt(timeMs) {
	let active = null;
	let next = null;
	for (let i = 0; i < recording.samples.length; i += 1) {
		const sample = recording.samples[i];
		if (sample.timeMs <= timeMs) {
			active = sample;
			next = recording.samples[i + 1] ?? null;
		} else {
			break;
		}
	}
	if (!active || active.visible === false || !active.assetId) return null;
	const asset = recording.assets.find((candidate) => candidate.id === active.assetId);
	if (!asset) return null;
	if (!next || next.visible === false || next.assetId !== active.assetId || next.timeMs <= active.timeMs) {
		return { sample: active, asset };
	}
	const t = clamp((timeMs - active.timeMs) / (next.timeMs - active.timeMs), 0, 1);
	return {
		asset,
		sample: {
			...active,
			cx: active.cx + (next.cx - active.cx) * t,
			cy: active.cy + (next.cy - active.cy) * t,
		},
	};
}

function drawFrame(timeMs) {
	ctx.clearRect(0, 0, canvas.width, canvas.height);
	ctx.fillStyle = "#181818";
	ctx.fillRect(0, 0, canvas.width, canvas.height);
	ctx.strokeStyle = "#2a2a2a";
	ctx.lineWidth = 1;
	for (let x = 0; x <= canvas.width; x += 80) {
		ctx.beginPath();
		ctx.moveTo(x, 0);
		ctx.lineTo(x, canvas.height);
		ctx.stroke();
	}
	for (let y = 0; y <= canvas.height; y += 60) {
		ctx.beginPath();
		ctx.moveTo(0, y);
		ctx.lineTo(canvas.width, y);
		ctx.stroke();
	}

	ctx.strokeStyle = "#5dd";
	ctx.lineWidth = 2;
	ctx.beginPath();
	for (const [index, sample] of recording.samples.entries()) {
		const x = sample.cx * canvas.width;
		const y = sample.cy * canvas.height;
		if (index === 0) ctx.moveTo(x, y);
		else ctx.lineTo(x, y);
	}
	ctx.stroke();

	const frame = frameAt(timeMs);
	if (!frame) return;
	const x = frame.sample.cx * canvas.width;
	const y = frame.sample.cy * canvas.height;
	const image = images.get(frame.asset.id);

	for (const scale of [1, 2, 3]) {
		const offsetX = (scale - 2) * 100 - 50;
		const drawWidth = frame.asset.width * scale;
		const drawHeight = frame.asset.height * scale;
		const hotspotX = frame.asset.hotspotX * scale;
		const hotspotY = frame.asset.hotspotY * scale;
		if (image) {
			ctx.drawImage(image, x + offsetX - hotspotX, y - hotspotY, drawWidth, drawHeight);
		}
		ctx.strokeStyle = "#f44";
		ctx.lineWidth = 2;
		ctx.beginPath();
		ctx.moveTo(x + offsetX - 8, y);
		ctx.lineTo(x + offsetX + 8, y);
		ctx.moveTo(x + offsetX, y - 8);
		ctx.lineTo(x + offsetX, y + 8);
		ctx.stroke();
		ctx.fillStyle = "#fff";
		ctx.fillText(scale + "x", x + offsetX + 12, y - 12);
	}
	drawPrettyArrow(ctx, x + 210, y, 3);
	ctx.strokeStyle = "#f44";
	ctx.lineWidth = 2;
	ctx.beginPath();
	ctx.moveTo(x + 210 - 8, y);
	ctx.lineTo(x + 210 + 8, y);
	ctx.moveTo(x + 210, y - 8);
	ctx.lineTo(x + 210, y + 8);
	ctx.stroke();
	ctx.fillStyle = "#fff";
	ctx.fillText("pretty 3x", x + 222, y - 12);
}

function drawPrettyArrow(context, x, y, scale) {
	context.save();
	context.translate(x, y);
	context.scale(scale, scale);
	context.shadowColor = "rgba(0, 0, 0, 0.35)";
	context.shadowBlur = 2;
	context.shadowOffsetY = 1;
	const path = new Path2D("M0 0 L0 23 L6.2 17 L10.5 29.5 L16.5 27.4 L12.2 15.2 L21.2 15.2 Z");
	context.fillStyle = "#ffffff";
	context.strokeStyle = "#111111";
	context.lineWidth = 1.35;
	context.lineJoin = "round";
	context.fill(path);
	context.stroke(path);
	context.restore();
}

function renderAssets() {
	const root = document.getElementById("assets");
	for (const asset of recording.assets) {
		const item = document.createElement("div");
		item.className = "asset";
		item.innerHTML = '<img src="' + asset.imageDataUrl + '" alt=""><div>' + asset.id + '</div><div>' + asset.width + 'x' + asset.height + ', hotspot ' + asset.hotspotX + ',' + asset.hotspotY + '</div>';
		root.appendChild(item);
	}
}

window.__exportWebm = async function() {
	await loadImages();
	const stream = canvas.captureStream(30);
	const recorder = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp9" });
	const chunks = [];
	recorder.ondataavailable = (event) => {
		if (event.data.size > 0) chunks.push(event.data);
	};
	const done = new Promise((resolve) => {
		recorder.onstop = resolve;
	});
	recorder.start();
	const startedAt = performance.now();
	await new Promise((resolve) => {
		function tick(now) {
			const elapsed = now - startedAt;
			drawFrame((elapsed / 3200) * durationMs);
			if (elapsed < 3200) requestAnimationFrame(tick);
			else resolve();
		}
		requestAnimationFrame(tick);
	});
	recorder.stop();
	await done;
	const blob = new Blob(chunks, { type: "video/webm" });
	const buffer = await blob.arrayBuffer();
	const bytes = new Uint8Array(buffer);
	let binary = "";
	for (let index = 0; index < bytes.length; index += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
	}
	return btoa(binary);
};

loadImages().then(() => {
	renderAssets();
	let startedAt = performance.now();
	function animate(now) {
		const elapsed = (now - startedAt) % 3200;
		drawFrame((elapsed / 3200) * durationMs);
		requestAnimationFrame(animate);
	}
	requestAnimationFrame(animate);
});
</script>
</body>
</html>`;
}

function readScreenFrames(outputDir, recordingStartTimestampMs) {
	const framesJsonPath = path.join(outputDir, "screen-frames", "frames.json");
	if (!fs.existsSync(framesJsonPath)) {
		return [];
	}

	const rawFrames = JSON.parse(fs.readFileSync(framesJsonPath, "utf8").replace(/^\uFEFF/, ""));
	const frames = Array.isArray(rawFrames) ? rawFrames : [rawFrames];

	return frames
		.filter((frame) => frame?.path && fs.existsSync(frame.path))
		.map((frame) => ({
			...frame,
			timeMs: Math.max(0, frame.timestampMs - recordingStartTimestampMs),
			imageDataUrl: `data:image/png;base64,${fs.readFileSync(frame.path).toString("base64")}`,
		}));
}

function buildRealCaptureHtml(report, recordingData, screenFrames) {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OpenScreen native cursor real capture diagnostic</title>
<style>
body { margin: 0; background: #080808; color: #eee; font-family: Arial, sans-serif; }
main { max-width: 1180px; margin: 0 auto; padding: 20px; }
h1 { font-size: 20px; margin: 0 0 12px; }
canvas { width: 100%; height: auto; background: #111; border: 1px solid #333; border-radius: 6px; }
.hint { color: #aaa; font-size: 13px; margin: 8px 0 14px; }
</style>
</head>
<body>
<main>
<h1>Real screen capture + reconstructed native cursor</h1>
<p class="hint">Background frames are real Windows screenshots. Native bitmaps are reconstructed at 1x, 2x, and 3x; the last cursor is a crisp vector 3x replacement. The red cross marks the recorded hotspot.</p>
<canvas id="preview" width="${screenFrames[0]?.width ?? 960}" height="${screenFrames[0]?.height ?? 540}"></canvas>
</main>
<script id="recording-data" type="application/json">${escapeScriptJson(recordingData)}</script>
<script id="screen-frames" type="application/json">${escapeScriptJson(screenFrames)}</script>
<script>
const recording = JSON.parse(document.getElementById("recording-data").textContent);
const frames = JSON.parse(document.getElementById("screen-frames").textContent);
const canvas = document.getElementById("preview");
const ctx = canvas.getContext("2d");
const durationMs = Math.max(1000, recording.samples.at(-1)?.timeMs ?? 1000);
const cursorImages = new Map();
const frameImages = [];

function clamp(value, min, max) {
	return Math.min(max, Math.max(min, value));
}

function loadImage(src) {
	return new Promise((resolve) => {
		const image = new Image();
		image.onload = () => resolve(image);
		image.src = src;
	});
}

async function loadImages() {
	await Promise.all(recording.assets.map(async (asset) => {
		cursorImages.set(asset.id, await loadImage(asset.imageDataUrl));
	}));
	for (const frame of frames) {
		frameImages.push({ ...frame, image: await loadImage(frame.imageDataUrl) });
	}
}

function closestFrame(timeMs) {
	let best = frameImages[0] ?? null;
	for (const frame of frameImages) {
		if (Math.abs(frame.timeMs - timeMs) < Math.abs((best?.timeMs ?? 0) - timeMs)) {
			best = frame;
		}
	}
	return best;
}

function frameAt(timeMs) {
	let active = null;
	let next = null;
	for (let i = 0; i < recording.samples.length; i += 1) {
		const sample = recording.samples[i];
		if (sample.timeMs <= timeMs) {
			active = sample;
			next = recording.samples[i + 1] ?? null;
		} else {
			break;
		}
	}
	if (!active || active.visible === false || !active.assetId) return null;
	const asset = recording.assets.find((candidate) => candidate.id === active.assetId);
	if (!asset) return null;
	if (!next || next.visible === false || next.assetId !== active.assetId || next.timeMs <= active.timeMs) {
		return { sample: active, asset };
	}
	const t = clamp((timeMs - active.timeMs) / (next.timeMs - active.timeMs), 0, 1);
	return {
		asset,
		sample: {
			...active,
			cx: active.cx + (next.cx - active.cx) * t,
			cy: active.cy + (next.cy - active.cy) * t,
		},
	};
}

function drawCursorVariant(frame, scale, offsetX) {
	const image = cursorImages.get(frame.asset.id);
	const x = frame.sample.cx * canvas.width + offsetX;
	const y = frame.sample.cy * canvas.height;
	const drawWidth = frame.asset.width * scale;
	const drawHeight = frame.asset.height * scale;
	const hotspotX = frame.asset.hotspotX * scale;
	const hotspotY = frame.asset.hotspotY * scale;
	if (image) {
		ctx.drawImage(image, x - hotspotX, y - hotspotY, drawWidth, drawHeight);
	}
	ctx.strokeStyle = "#ff3333";
	ctx.lineWidth = 2;
	ctx.beginPath();
	ctx.moveTo(x - 9, y);
	ctx.lineTo(x + 9, y);
	ctx.moveTo(x, y - 9);
	ctx.lineTo(x, y + 9);
	ctx.stroke();
	ctx.fillStyle = "#ffffff";
	ctx.fillText(scale + "x", x + 12, y - 12);
}

function drawPrettyArrow(x, y, scale) {
	ctx.save();
	ctx.translate(x, y);
	ctx.scale(scale, scale);
	ctx.shadowColor = "rgba(0, 0, 0, 0.35)";
	ctx.shadowBlur = 2;
	ctx.shadowOffsetY = 1;
	const path = new Path2D("M0 0 L0 23 L6.2 17 L10.5 29.5 L16.5 27.4 L12.2 15.2 L21.2 15.2 Z");
	ctx.fillStyle = "#ffffff";
	ctx.strokeStyle = "#111111";
	ctx.lineWidth = 1.35;
	ctx.lineJoin = "round";
	ctx.fill(path);
	ctx.stroke(path);
	ctx.restore();
}

function drawPrettyCursorVariant(frame, scale, offsetX) {
	const x = frame.sample.cx * canvas.width + offsetX;
	const y = frame.sample.cy * canvas.height;
	drawPrettyArrow(x, y, scale);
	ctx.strokeStyle = "#ff3333";
	ctx.lineWidth = 2;
	ctx.beginPath();
	ctx.moveTo(x - 9, y);
	ctx.lineTo(x + 9, y);
	ctx.moveTo(x, y - 9);
	ctx.lineTo(x, y + 9);
	ctx.stroke();
	ctx.fillStyle = "#ffffff";
	ctx.fillText("pretty " + scale + "x", x + 12, y - 12);
}

function drawFrame(timeMs) {
	const background = closestFrame(timeMs);
	ctx.clearRect(0, 0, canvas.width, canvas.height);
	if (background) {
		ctx.drawImage(background.image, 0, 0, canvas.width, canvas.height);
	} else {
		ctx.fillStyle = "#111";
		ctx.fillRect(0, 0, canvas.width, canvas.height);
	}
	const frame = frameAt(timeMs);
	if (!frame) return;
	drawCursorVariant(frame, 1, -150);
	drawCursorVariant(frame, 2, -40);
	drawCursorVariant(frame, 3, 90);
	drawPrettyCursorVariant(frame, 3, 245);
}

window.__exportWebm = async function() {
	await loadImages();
	const stream = canvas.captureStream(30);
	const recorder = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp9" });
	const chunks = [];
	recorder.ondataavailable = (event) => {
		if (event.data.size > 0) chunks.push(event.data);
	};
	const done = new Promise((resolve) => {
		recorder.onstop = resolve;
	});
	recorder.start();
	const startedAt = performance.now();
	await new Promise((resolve) => {
		function tick(now) {
			const elapsed = now - startedAt;
			drawFrame((elapsed / 3600) * durationMs);
			if (elapsed < 3600) requestAnimationFrame(tick);
			else resolve();
		}
		requestAnimationFrame(tick);
	});
	recorder.stop();
	await done;
	const blob = new Blob(chunks, { type: "video/webm" });
	const buffer = await blob.arrayBuffer();
	const bytes = new Uint8Array(buffer);
	let binary = "";
	for (let index = 0; index < bytes.length; index += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
	}
	return btoa(binary);
};

loadImages().then(() => {
	let startedAt = performance.now();
	function animate(now) {
		const elapsed = (now - startedAt) % 3600;
		drawFrame((elapsed / 3600) * durationMs);
		requestAnimationFrame(animate);
	}
	requestAnimationFrame(animate);
});
</script>
</body>
</html>`;
}

function findPlaywrightChromiumExecutable(defaultPath) {
	if (fs.existsSync(defaultPath)) {
		return defaultPath;
	}

	const baseDir = path.join(process.env.LOCALAPPDATA ?? "", "ms-playwright");
	if (!baseDir || !fs.existsSync(baseDir)) {
		return defaultPath;
	}

	const candidates = fs
		.readdirSync(baseDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && entry.name.startsWith("chromium-"))
		.map((entry) => ({
			executablePath: path.join(baseDir, entry.name, "chrome-win64", "chrome.exe"),
			revision: Number.parseInt(entry.name.slice("chromium-".length), 10),
		}))
		.filter(
			(candidate) => Number.isFinite(candidate.revision) && fs.existsSync(candidate.executablePath),
		)
		.sort((a, b) => b.revision - a.revision)
		.map((candidate) => candidate.executablePath);

	return candidates[0] ?? defaultPath;
}

async function writePreviewVideo(reportPath, outputPath) {
	const { chromium } = await import("playwright");
	const browser = await chromium.launch({
		executablePath: findPlaywrightChromiumExecutable(chromium.executablePath()),
		headless: true,
	});
	try {
		const page = await browser.newPage({ viewport: { width: 1180, height: 760 } });
		await page.goto(`file:///${reportPath.replaceAll("\\", "/")}`);
		const base64 = await page.evaluate(() => window.__exportWebm());
		fs.writeFileSync(outputPath, Buffer.from(base64, "base64"));
	} finally {
		await browser.close();
	}
}

function assertReport(report) {
	const failures = [];
	if (report.sampleCount < Math.floor(DURATION_MS / SAMPLE_INTERVAL_MS / 3)) {
		failures.push(`Too few samples: ${report.sampleCount}.`);
	}
	if (report.visibleSampleCount === 0) {
		failures.push("No visible cursor samples were captured.");
	}
	if (report.assetCount === 0) {
		failures.push("No cursor asset PNG was captured.");
	}
	if (report.uniquePositionCount < 4) {
		failures.push(`Cursor movement was not observed enough times: ${report.uniquePositionCount}.`);
	}
	if (report.errorCount > 0) {
		failures.push(`Sampler reported ${report.errorCount} error event(s).`);
	}
	if (report.leftButtonPressedSampleCount === 0 || report.clickSampleCount === 0) {
		failures.push("Left button click interaction was not observed.");
	}

	if (failures.length > 0) {
		throw new Error(failures.join(" "));
	}
}

fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const events = [];
const assets = new Map();
let lineBuffer = "";
let stoppingSampler = false;
const readyWaiter = createReadyWaiter();
const sampler = spawnPowerShell(buildSamplerScript(), {
	onStdout: (chunk) => {
		lineBuffer += chunk;
		const lines = lineBuffer.split(/\r?\n/);
		lineBuffer = lines.pop() ?? "";

		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed) {
				continue;
			}

			let event;
			try {
				event = JSON.parse(trimmed);
			} catch {
				process.stderr.write(`[cursor-native-test] dropping non-JSON line: ${trimmed}\n`);
				continue;
			}
			events.push(event);
			if (event.type === "ready") {
				readyWaiter.resolve();
			}
			if (event.asset?.id && !assets.has(event.asset.id)) {
				assets.set(event.asset.id, event.asset);
			}
		}
	},
	onStderr: (chunk) => {
		if (!stoppingSampler && !chunk.startsWith("#< CLIXML")) {
			process.stderr.write(`[cursor-native-test] ${chunk}`);
		}
	},
});
let screenRecorder = null;

try {
	await readyWaiter.promise;
	screenRecorder = spawnPowerShell(buildScreenRecorderScript(OUTPUT_DIR, DURATION_MS), {
		onStderr: (chunk) => {
			if (!chunk.startsWith("#< CLIXML") && !chunk.startsWith("<Objs")) {
				process.stderr.write(`[screen-capture-test] ${chunk}`);
			}
		},
	});
	await new Promise((resolve) => setTimeout(resolve, 150));
	await runPowerShell(buildMousePathScript(DURATION_MS));
	await new Promise((resolve) => setTimeout(resolve, Math.max(250, SAMPLE_INTERVAL_MS * 3)));
	await screenRecorder.done;
} finally {
	if (!sampler.child.killed) {
		stoppingSampler = true;
		sampler.child.kill();
	}
	if (screenRecorder && !screenRecorder.child.killed) {
		screenRecorder.child.kill();
	}
}

const samples = events.filter((event) => event.type === "sample");
const errors = events.filter((event) => event.type === "error");
const recordingStartTimestampMs = samples[0]?.timestampMs ?? Date.now();
const uniquePositions = new Set(samples.map((sample) => `${sample.x},${sample.y}`));
let previousLeftButtonDown = false;
let clickSampleCount = 0;
for (const sample of samples) {
	const leftButtonDown = sample.leftButtonDown === true;
	const leftButtonPressed = sample.leftButtonPressed === true;
	if (leftButtonPressed || (leftButtonDown && !previousLeftButtonDown)) {
		clickSampleCount += 1;
	}
	previousLeftButtonDown = leftButtonDown;
}
const report = {
	outputDir: OUTPUT_DIR,
	sampleIntervalMs: SAMPLE_INTERVAL_MS,
	durationMs: DURATION_MS,
	eventCount: events.length,
	sampleCount: samples.length,
	visibleSampleCount: samples.filter((sample) => sample.visible).length,
	assetCount: assets.size,
	uniqueCursorHandleCount: new Set(samples.map((sample) => sample.handle).filter(Boolean)).size,
	uniquePositionCount: uniquePositions.size,
	leftButtonDownSampleCount: samples.filter((sample) => sample.leftButtonDown === true).length,
	leftButtonPressedSampleCount: samples.filter((sample) => sample.leftButtonPressed === true)
		.length,
	clickSampleCount,
	errorCount: errors.length,
	firstSample: samples[0] ?? null,
	lastSample: samples.at(-1) ?? null,
	assets: [...assets.values()].map((asset) => ({
		id: asset.id,
		width: asset.width,
		height: asset.height,
		hotspotX: asset.hotspotX,
		hotspotY: asset.hotspotY,
		cursorType: asset.cursorType ?? null,
	})),
};
const recordingData = toRecordingData(samples, assets);
const screenFrames = readScreenFrames(OUTPUT_DIR, recordingStartTimestampMs);
const reportHtmlPath = path.join(OUTPUT_DIR, "report.html");
const previewVideoPath = path.join(OUTPUT_DIR, "preview.webm");
const realCaptureHtmlPath = path.join(OUTPUT_DIR, "real-capture-report.html");
const realCaptureVideoPath = path.join(OUTPUT_DIR, "real-capture-preview.webm");

writeAssets(assets, OUTPUT_DIR);
fs.writeFileSync(path.join(OUTPUT_DIR, "events.json"), JSON.stringify(events, null, 2));
fs.writeFileSync(
	path.join(OUTPUT_DIR, "cursor-recording-data.json"),
	JSON.stringify(recordingData, null, 2),
);
fs.writeFileSync(path.join(OUTPUT_DIR, "report.json"), JSON.stringify(report, null, 2));
fs.writeFileSync(reportHtmlPath, buildVisualReportHtml(report, recordingData));
if (screenFrames.length > 0) {
	fs.writeFileSync(realCaptureHtmlPath, buildRealCaptureHtml(report, recordingData, screenFrames));
	report.screenFrameCount = screenFrames.length;
}

try {
	await writePreviewVideo(reportHtmlPath, previewVideoPath);
	report.previewVideoPath = previewVideoPath;
} catch (error) {
	report.previewVideoError = error instanceof Error ? error.message : String(error);
}

if (screenFrames.length > 0) {
	try {
		await writePreviewVideo(realCaptureHtmlPath, realCaptureVideoPath);
		report.realCaptureVideoPath = realCaptureVideoPath;
	} catch (error) {
		report.realCaptureVideoError = error instanceof Error ? error.message : String(error);
	}
}

fs.writeFileSync(path.join(OUTPUT_DIR, "report.json"), JSON.stringify(report, null, 2));

assertReport(report);

console.log(JSON.stringify(report, null, 2));
