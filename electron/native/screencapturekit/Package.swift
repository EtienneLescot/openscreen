// swift-tools-version: 5.9

import PackageDescription

let package = Package(
	name: "OpenScreenScreenCaptureKitHelper",
	// macOS 13 is DELIBERATE, and it is the same number the app declares in
	// electron-builder.json5 (`mac.minimumSystemVersion`) and promises in the README.
	// Those three must move together; scripts/check-macos-deployment-target.test.mjs
	// asserts this one never rises above what the app declares.
	//
	// It has to be at least 13 regardless: ScreenCaptureRecorder is
	// `@available(macOS 13.0, *)` and its main() hard-guards `#available(macOS 13.0, *)`,
	// because SCStream's usable surface starts there.
	//
	// What this block is NOT allowed to become is higher than the declared floor, which is
	// how #515 happened. The floor was set here when ScreenCaptureKit was the only target;
	// openscreen-macos-cursor-helper was added later and inherited it, because SwiftPM has
	// no per-target override. The app then advertised macOS 12 while shipping a 13-only
	// helper, and the damage was not the version number: at a deployment target >= 13 the
	// linker resolves the Swift Foundation overlay symbols against Foundation.framework and
	// drops /usr/lib/swift/libswiftFoundation.dylib from the load commands, so on macOS 12
	// the helper died in dyld before it could speak — which the app reported to the user as
	// a denied Accessibility grant.
	platforms: [
		.macOS(.v13)
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
