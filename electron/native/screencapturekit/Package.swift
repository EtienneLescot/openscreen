// swift-tools-version: 5.9

import PackageDescription

let package = Package(
	name: "OpenScreenScreenCaptureKitHelper",
	// PACKAGE-WIDE, and SwiftPM has no per-target override — so this floor is also
	// the floor of `openscreen-macos-cursor-helper`, which needs nothing newer than
	// 10.15. It was set to .v13 in b9e21347, when ScreenCaptureKit was the only thing
	// in here; the cursor helper arrived in b2f9afab and silently inherited it.
	//
	// That is not a cosmetic mismatch. At a deployment target >= 13 the linker resolves
	// the Swift Foundation overlay symbols against Foundation.framework directly and
	// DROPS /usr/lib/swift/libswiftFoundation.dylib from the load commands (the SDK's
	// `$ld$previous$/usr/lib/swift/libswiftFoundation.dylib$1.0.0$1$10.15$13.0$…`
	// directives are the cutover). On macOS 12 those symbols live only in that dylib,
	// which the binary no longer loads, so dyld kills the helper before it prints its
	// `ready` line — which the app then reported as a denied Accessibility grant.
	// See issue #515.
	//
	// .v12 and not "12.3": at 12.0 ScreenCaptureKit is WEAK-linked, so a 12.0–12.2 host
	// still execs the capture helper and reaches the legible `HelperError.unsupportedMacOS`
	// guard in ScreenCaptureRecorder.main(). At 12.3 it becomes a hard LC_LOAD_DYLIB and
	// that host dies in dyld instead. Native capture still requires macOS 13 — that floor
	// is enforced in Swift by `@available(macOS 13.0, *)` on ScreenCaptureRecorder.
	platforms: [
		.macOS(.v12)
	],
	products: [
		.executable(
			name: "openscreen-screencapturekit-helper",
			targets: ["OpenScreenScreenCaptureKitHelper"]
		),
		.executable(
			name: "openscreen-macos-cursor-helper",
			targets: ["OpenScreenMacOSCursorHelper"]
		)
	],
	targets: [
		// The parts of the helper that are testable without a screen, a display server or a
		// TCC grant. A library rather than files in the executable target because a test
		// target cannot link an executable's `@main` — and until this split existed nothing
		// under this package could be tested at all, which is how PR #343 came to carry 301
		// lines of Swift tests that no pull request ever ran.
		.target(
			name: "OpenScreenCaptureCore",
			path: "Sources/OpenScreenCaptureCore"
		),
		.executableTarget(
			name: "OpenScreenScreenCaptureKitHelper",
			dependencies: ["OpenScreenCaptureCore"],
			path: "Sources/OpenScreenScreenCaptureKitHelper"
		),
		.executableTarget(
			name: "OpenScreenMacOSCursorHelper",
			path: "Sources/OpenScreenMacOSCursorHelper"
		),
		.testTarget(
			name: "OpenScreenCaptureCoreTests",
			dependencies: ["OpenScreenCaptureCore"],
			path: "Tests/OpenScreenCaptureCoreTests"
		)
	]
)
