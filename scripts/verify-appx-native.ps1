<#
.SYNOPSIS
Proves every native binary in a built .appx can actually load, from inside a
registered MSIX package.

.DESCRIPTION
Twice in a row a Windows release shipped a dependency that could not be resolved
on the target machine, and both times someone else found it:

  1.9.0  compositor_view.node sat one directory away from its ffmpeg DLLs and was
         reached via PATH. MSIX resolves dependent DLLs through the package graph
         and ignores PATH, so the Store build loaded no compositor: the editor
         opened with a permanently blank preview while audio kept playing.

  1.9.1  wgc-capture.exe, cursor-sampler.exe and compositor_view.node imported
         VCRUNTIME140/MSVCP140 from the Visual C++ Redistributable, which is not
         part of Windows. Store certification rejected the submission: recording
         died with 0xC0000135, STATUS_DLL_NOT_FOUND, before main().

Each fix came with a guard aimed at the failure already understood, and neither
guard would have caught the other one. That is the gap this script closes. Rather
than asserting a known-bad pattern, it registers the package and asks the Windows
loader to resolve every shipped binary for real. Whatever the next unresolvable
dependency turns out to be, this fails on it.

It deliberately does NOT record anything. A real capture needs a GPU and a desktop
session, which a CI runner does not usefully have, and a flaky gate gets switched
off. The loader is the part that broke both times, and it can be tested with
neither.

ASCII only, on purpose: Windows PowerShell 5.1 reads a .ps1 as ANSI unless it
carries a BOM, so a stray em dash turns into a parser error rather than a typo.

.PARAMETER Appx
The .appx to verify.

.PARAMETER KeepRegistered
Leave the package registered afterwards, to click through the app by hand.

.EXAMPLE
powershell -File scripts/verify-appx-native.ps1 -Appx release/1.9.1/Openscreen.Setup.1.9.1.appx

.NOTES
Loose registration needs Developer Mode (Settings > System > For developers).
This script will not enable it: that is a machine-wide setting and its owner
should be the one turning it on. CI sets AllowDevelopmentWithoutDevLicense itself,
on a runner that is thrown away afterwards.

Run it with Windows PowerShell, not pwsh: the Appx module is not loaded natively
in PowerShell 7 and needs -UseWindowsPowerShell to work at all.
#>
[CmdletBinding(DefaultParameterSetName = "Verify")]
param(
	[Parameter(Mandatory, ParameterSetName = "Verify")]
	[string]$Appx,

	[Parameter(ParameterSetName = "Verify")]
	[switch]$KeepRegistered,

	# Set when the script re-invokes itself inside the package container. Not for
	# direct use: outside the container it proves nothing, because a developer
	# machine resolves through PATH and System32 exactly the way the Store does not.
	[Parameter(Mandatory, ParameterSetName = "InPackage")]
	[switch]$InPackage,

	[Parameter(Mandatory, ParameterSetName = "InPackage")]
	[string]$PackageRoot,

	[Parameter(Mandatory, ParameterSetName = "InPackage")]
	[string]$ReportPath
)

$ErrorActionPreference = "Stop"

# 0xC0000135. Surfaces as a negative Int32 through Process.ExitCode.
$STATUS_DLL_NOT_FOUND = -1073741515

function Get-NativeDir {
	param([string]$Root)
	return (Join-Path $Root "app\resources\electron\native\bin\win32-x64")
}

# ---------------------------------------------------------------- in-package --

if ($InPackage) {
	# LOAD_WITH_ALTERED_SEARCH_PATH is the flag Node passes for a .node addon, so
	# the module's own directory is searched for its dependencies. Using the same
	# flag is what makes this a test of require() rather than of something adjacent.
	Add-Type -Namespace OpenScreen -Name Loader -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true, CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
public static extern System.IntPtr LoadLibraryExW(string path, System.IntPtr file, uint flags);
'@

	$results = @()
	$dir = Get-NativeDir -Root $PackageRoot

	# This path is hard-coded, so a change to the AppX resource layout silently moves
	# the payload out from under it. Without this check Get-ChildItem throws under
	# $ErrorActionPreference = "Stop", the child dies before writing its report, and
	# the parent spends its full timeout to conclude only that no report arrived --
	# true, useless, and three minutes late. Report the real cause as a finding
	# instead, so it travels back through the same channel as every other failure.
	if (-not (Test-Path $dir)) {
		@([pscustomobject]@{
			name   = $dir
			kind   = "layout"
			ok     = $false
			detail = "the package has no native payload at this path; the AppX resource layout changed"
		}) | ConvertTo-Json -Depth 4 | Set-Content -Path $ReportPath -Encoding utf8
		return
	}

	foreach ($file in Get-ChildItem -Path $dir -File | Where-Object { $_.Extension -match '^\.(dll|node)$' }) {
		$handle = [OpenScreen.Loader]::LoadLibraryExW($file.FullName, [IntPtr]::Zero, 0x00000008)
		$lastError = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
		$loaded = ($handle -ne [IntPtr]::Zero)
		# 126 is ERROR_MOD_NOT_FOUND: a dependency of this binary is missing, which
		# is the same story 0xC0000135 tells about an executable.
		$detail = "loaded"
		if (-not $loaded) { $detail = "LoadLibraryEx failed, GetLastError=$lastError" }
		$results += [pscustomobject]@{ name = $file.Name; kind = "load"; ok = $loaded; detail = $detail }
	}

	# The helpers are separate processes, so their imports resolve at CreateProcess
	# time and a failure never reaches their own code. Started with no arguments on
	# purpose: each one prints its usage and exits, which needs no GPU, no desktop
	# session and no capture, while still proving the loader let it start. A binary
	# the loader rejects produces NO output at all and exits STATUS_DLL_NOT_FOUND.
	foreach ($name in @("wgc-capture.exe", "cursor-sampler.exe", "whisper-stt-server.exe")) {
		$exe = Join-Path $dir $name
		if (-not (Test-Path $exe)) {
			$results += [pscustomobject]@{ name = $name; kind = "start"; ok = $false; detail = "not present in the package" }
			continue
		}

		$psi = New-Object System.Diagnostics.ProcessStartInfo
		$psi.FileName = $exe
		$psi.UseShellExecute = $false
		$psi.RedirectStandardOutput = $true
		$psi.RedirectStandardError = $true
		$psi.CreateNoWindow = $true
		$proc = [System.Diagnostics.Process]::Start($psi)
		# Both pipes are started draining before anything blocks. Reading one to the
		# end while the other fills its buffer deadlocks the pair: the child blocks
		# writing to stderr, the parent blocks reading stdout, and the WaitForExit
		# below never runs to break it. Today these print three words each, so the
		# buffer never fills -- the hang would arrive the day a helper turns chatty,
		# which is exactly when this check is earning its place.
		$stdoutTask = $proc.StandardOutput.ReadToEndAsync()
		$stderrTask = $proc.StandardError.ReadToEndAsync()
		if (-not $proc.WaitForExit(20000)) { $proc.Kill() }
		$stdout = $stdoutTask.GetAwaiter().GetResult()
		$stderr = $stderrTask.GetAwaiter().GetResult()

		$exitCode = "still running"
		if ($proc.HasExited) { $exitCode = $proc.ExitCode }

		$said = ($stdout + $stderr).Trim()
		$firstLine = ""
		if ($said.Length -gt 0) { $firstLine = @($said -split "`r?`n")[0] }

		# "Said something" is the assertion, not "exited non-zero": these all exit 1
		# when told nothing to do. Only a process that reached its own main() prints.
		$ok = ($said.Length -gt 0) -and ($exitCode -ne $STATUS_DLL_NOT_FOUND)
		$detail = "exit=$exitCode with NO output, killed by the loader before main()"
		if ($said.Length -gt 0) { $detail = "exit=$exitCode, said: $firstLine" }
		$results += [pscustomobject]@{ name = $name; kind = "start"; ok = $ok; detail = $detail }
	}

	$results | ConvertTo-Json -Depth 4 | Set-Content -Path $ReportPath -Encoding utf8
	return
}

# ------------------------------------------------------------- orchestration --

$appxPath = (Resolve-Path $Appx).Path
$work = Join-Path ([System.IO.Path]::GetTempPath()) ("openscreen-appx-verify-" + [System.IO.Path]::GetRandomFileName())
$extracted = Join-Path $work "package"
$report = Join-Path $work "report.json"
$registered = $null

try {
	Write-Host "Extracting $([System.IO.Path]::GetFileName($appxPath))"
	New-Item -ItemType Directory -Path $work -Force | Out-Null
	# Expand-Archive insists on the extension even though an .appx is a plain zip.
	$zip = Join-Path $work "package.zip"
	Copy-Item $appxPath $zip
	Expand-Archive -Path $zip -DestinationPath $extracted -Force
	Remove-Item $zip -Force

	# A loose registration is unsigned by definition, and these two describe a
	# signed layout. Leaving them makes Add-AppxPackage reject the directory.
	Remove-Item (Join-Path $extracted "AppxSignature.p7x"), (Join-Path $extracted "AppxBlockMap.xml") -Force -ErrorAction SilentlyContinue

	$manifest = Join-Path $extracted "AppxManifest.xml"
	if (-not (Test-Path $manifest)) { throw "no AppxManifest.xml in $appxPath, is it really an appx?" }

	Write-Host "Registering the package"
	try {
		Add-AppxPackage -Register $manifest -ErrorAction Stop
	}
	catch {
		throw "Add-AppxPackage -Register failed: $($_.Exception.Message)`n`nLoose registration needs Developer Mode (Settings > System > For developers)."
	}

	$pkg = Get-AppxPackage -Name "EtienneLescot.OpenScreen"
	if (-not $pkg) { throw "the package registered but cannot be found by name" }
	$registered = $pkg.PackageFullName
	Write-Host "Registered $($pkg.PackageFullName)"

	# Invoke-CommandInDesktopPackage gives the child package identity, which is the
	# entire point: outside it, PATH and System32 paper over exactly the failures
	# being looked for. It returns no output, so the child reports through a file.
	$childArgs = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -InPackage -PackageRoot `"$extracted`" -ReportPath `"$report`""
	Invoke-CommandInDesktopPackage `
		-PackageFamilyName $pkg.PackageFamilyName `
		-AppId "Openscreen" `
		-Command "powershell.exe" `
		-Args $childArgs `
		-ErrorAction Stop

	$deadline = (Get-Date).AddSeconds(180)
	while (-not (Test-Path $report) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
	if (-not (Test-Path $report)) { throw "the in-package probe never wrote its report" }

	# `@(ConvertFrom-Json ...)` looks like it produces an array and does not: Windows
	# PowerShell 5.1 writes the whole deserialized array to the pipeline as ONE
	# object, so @() wraps it into a single-element array holding an array. The first
	# version of this script printed "All 1 native binaries load" for seventeen of
	# them, and `Where-Object { -not $_.ok }` evaluated `-not` against an array of
	# booleans, which is always false. It would have reported success no matter what
	# the probe found. `foreach` over the variable enumerates properly.
	$results = @()
	foreach ($item in (Get-Content $report -Raw | ConvertFrom-Json)) { $results += $item }
	if ($results.Count -eq 0) { throw "the in-package probe found no native binaries to check" }

	# Printed before anything is asserted, so whatever the probe actually found is on
	# screen even when the run ends in a throw.
	foreach ($r in $results) {
		$mark = "ok  "
		if (-not $r.ok) { $mark = "FAIL" }
		Write-Host "  $mark $($r.kind)`t$($r.name)`t$($r.detail)"
	}

	# An explicit failure is reported ahead of the count check below, which would
	# otherwise swallow it: the probe reports a missing payload directory as a single
	# finding, and "only checked 1 binaries" would replace an accurate diagnosis with
	# a vague one.
	$failed = @($results | Where-Object { -not $_.ok })
	if ($failed.Count -gt 0) {
		foreach ($r in $failed) { Write-Output "::error::$($r.name): $($r.detail)" }
		throw "$($failed.Count) of $($results.Count) checks failed under package identity"
	}

	# Reached only when everything passed, which is exactly when a probe that quietly
	# stopped looking is indistinguishable from a healthy package. The payload is
	# fourteen libraries and three helpers; an exact count would be brittle, but a
	# clean report covering two files is not a pass, it is a broken probe.
	if ($results.Count -lt 10) {
		throw "the in-package probe only checked $($results.Count) binaries, which is too few to be the real payload"
	}

	Write-Host "All $($results.Count) native binaries load under package identity."
}
finally {
	if ($registered -and -not $KeepRegistered) {
		Remove-AppxPackage -Package $registered -ErrorAction SilentlyContinue
	}
	if (-not $KeepRegistered) {
		Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
	}
}
