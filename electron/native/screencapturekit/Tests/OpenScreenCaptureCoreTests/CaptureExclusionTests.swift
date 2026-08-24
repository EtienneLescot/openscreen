import XCTest
@testable import OpenScreenCaptureCore

final class CaptureExclusionTests: XCTestCase {
	private let applications = [
		CaptureExclusionApplication(processID: 10, bundleIdentifier: "com.openscreen.app"),
		CaptureExclusionApplication(processID: 11, bundleIdentifier: "com.openscreen.app"),
		CaptureExclusionApplication(processID: 20, bundleIdentifier: "com.example.other"),
	]

	func testExpandsRequestedPIDToEveryApplicationWithSameBundle() throws {
		let result = try resolveCaptureExclusion(
			requestedProcessIDs: [10],
			requestedWindowIDs: [100],
			applications: applications,
			availableWindowIDs: [100]
		)
		XCTAssertEqual(
			result.strategy,
			.applications(bundleIdentifiers: ["com.openscreen.app"], processIDs: [10, 11])
		)
		XCTAssertEqual(result.matchedApplicationCount, 2)
	}

	func testUsesResolvedWindowsOnlyWhenApplicationResolutionIsUnavailable() throws {
		let result = try resolveCaptureExclusion(
			requestedProcessIDs: [999],
			requestedWindowIDs: [101, 100, 101],
			applications: applications,
			availableWindowIDs: [100, 101, 200]
		)
		XCTAssertEqual(result.strategy, .windows(windowIDs: [100, 101]))
		XCTAssertEqual(result.matchedWindowCount, 2)
	}

	func testRefusesPartialWindowResolution() {
		XCTAssertThrowsError(
			try resolveCaptureExclusion(
				requestedProcessIDs: [999],
				requestedWindowIDs: [100, 101],
				applications: applications,
				availableWindowIDs: [100]
			)
		) { error in
			XCTAssertEqual(error as? CaptureExclusionResolutionError, .safeExclusionUnavailable)
		}
	}

	func testRefusesMissingApplicationAndWindowMatches() {
		XCTAssertThrowsError(
			try resolveCaptureExclusion(
				requestedProcessIDs: [999],
				requestedWindowIDs: [],
				applications: applications,
				availableWindowIDs: []
			)
		)
	}

	func testLegacyRequestWithoutExclusionsSelectsNoFiltering() throws {
		let fields = try JSONDecoder().decode(
			CaptureExclusionRequestFields.self,
			from: Data("{}".utf8)
		)
		XCTAssertEqual(fields.applicationProcessIDs, [])
		XCTAssertEqual(fields.windowIDs, [])

		let result = try resolveCaptureExclusion(
			requestedProcessIDs: [],
			requestedWindowIDs: [],
			applications: applications,
			availableWindowIDs: [100]
		)
		XCTAssertEqual(result.strategy, .none)
	}
}
