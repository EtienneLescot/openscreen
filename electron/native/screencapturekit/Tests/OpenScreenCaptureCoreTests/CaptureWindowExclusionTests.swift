import XCTest
@testable import OpenScreenCaptureCore

final class CaptureWindowExclusionTests: XCTestCase {
	func testResolvesUniqueRequestedWindowsInRequestOrder() {
		XCTAssertEqual(
			resolveCaptureExcludedWindowIDs(
				requestedWindowIDs: [42, 7, 42, 99],
				availableWindowIDs: [99, 42, 7, 500]
			),
			[42, 7, 99]
		)
	}

	func testIgnoresWindowsUnavailableToScreenCaptureKit() {
		XCTAssertEqual(
			resolveCaptureExcludedWindowIDs(
				requestedWindowIDs: [42, 404, 7],
				availableWindowIDs: [7, 42]
			),
			[42, 7]
		)
	}

	func testLegacyRequestWithoutExclusionsRemainsEmpty() {
		XCTAssertEqual(
			resolveCaptureExcludedWindowIDs(
				requestedWindowIDs: [],
				availableWindowIDs: [42]
			),
			[]
		)
	}
}
