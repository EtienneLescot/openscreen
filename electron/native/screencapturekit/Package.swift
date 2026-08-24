// swift-tools-version: 5.9

import PackageDescription

let package = Package(
	name: "OpenScreenScreenCaptureKitHelper",
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
