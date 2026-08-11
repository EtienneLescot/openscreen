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
		.executableTarget(
			name: "OpenScreenScreenCaptureKitHelper",
			path: "Sources/OpenScreenScreenCaptureKitHelper"
		),
		.executableTarget(
			name: "OpenScreenMacOSCursorHelper",
			path: "Sources/OpenScreenMacOSCursorHelper"
		),
		.testTarget(
			name: "OpenScreenScreenCaptureKitHelperTests",
			dependencies: ["OpenScreenScreenCaptureKitHelper"]
		)
	]
)
