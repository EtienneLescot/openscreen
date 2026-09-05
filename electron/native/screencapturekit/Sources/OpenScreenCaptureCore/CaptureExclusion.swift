import Foundation

public struct CaptureExclusionRequestFields: Decodable, Equatable, Sendable {
	public let applicationProcessIDs: [Int32]
	public let windowIDs: [UInt32]

	private enum CodingKeys: String, CodingKey {
		case excludedApplicationProcessIds
		case excludedWindowIds
	}

	public init(from decoder: Decoder) throws {
		let container = try decoder.container(keyedBy: CodingKeys.self)
		applicationProcessIDs =
			try container.decodeIfPresent([Int32].self, forKey: .excludedApplicationProcessIds) ?? []
		windowIDs = try container.decodeIfPresent([UInt32].self, forKey: .excludedWindowIds) ?? []
	}
}

public struct CaptureExclusionApplication: Equatable, Sendable {
	public let processID: Int32
	public let bundleIdentifier: String?

	public init(processID: Int32, bundleIdentifier: String?) {
		self.processID = processID
		self.bundleIdentifier = bundleIdentifier
	}
}

public enum CaptureExclusionStrategy: Equatable, Sendable {
	case none
	case applications(bundleIdentifiers: [String], processIDs: [Int32])
	case windows(windowIDs: [UInt32])
}

public struct CaptureExclusionResolution: Equatable, Sendable {
	public let strategy: CaptureExclusionStrategy
	public let requestedProcessIDs: [Int32]
	public let requestedWindowIDs: [UInt32]
	public let matchedApplicationCount: Int
	public let matchedWindowCount: Int

	public init(
		strategy: CaptureExclusionStrategy,
		requestedProcessIDs: [Int32],
		requestedWindowIDs: [UInt32],
		matchedApplicationCount: Int,
		matchedWindowCount: Int
	) {
		self.strategy = strategy
		self.requestedProcessIDs = requestedProcessIDs
		self.requestedWindowIDs = requestedWindowIDs
		self.matchedApplicationCount = matchedApplicationCount
		self.matchedWindowCount = matchedWindowCount
	}
}

public enum CaptureExclusionResolutionError: Error, Equatable {
	case safeExclusionUnavailable
}

/// Selects one safe ScreenCaptureKit filter strategy without importing the framework.
/// Window IDs are a separate fallback; they are never treated as `exceptingWindows`.
public func resolveCaptureExclusion(
	requestedProcessIDs: [Int32],
	requestedWindowIDs: [UInt32],
	applications: [CaptureExclusionApplication],
	availableWindowIDs: [UInt32]
) throws -> CaptureExclusionResolution {
	let uniqueProcessIDs = Array(Set(requestedProcessIDs)).sorted()
	let uniqueWindowIDs = Array(Set(requestedWindowIDs)).sorted()
	if uniqueProcessIDs.isEmpty && uniqueWindowIDs.isEmpty {
		return CaptureExclusionResolution(
			strategy: .none,
			requestedProcessIDs: [],
			requestedWindowIDs: [],
			matchedApplicationCount: 0,
			matchedWindowCount: 0
		)
	}

	let requestedPIDSet = Set(uniqueProcessIDs)
	let directlyMatched = applications.filter { requestedPIDSet.contains($0.processID) }
	let bundleIdentifiers = Array(
		Set<String>(directlyMatched.compactMap { application in
			guard let bundle = application.bundleIdentifier?.trimmingCharacters(in: .whitespacesAndNewlines),
				!bundle.isEmpty
			else { return nil }
			return bundle
		})
	).sorted()

	if !bundleIdentifiers.isEmpty {
		let bundleSet = Set(bundleIdentifiers)
		let expandedProcessIDs = applications
			.filter { application in
				guard let bundle = application.bundleIdentifier else { return false }
				return bundleSet.contains(bundle)
			}
			.map(\.processID)
			.sorted()
		return CaptureExclusionResolution(
			strategy: .applications(
				bundleIdentifiers: bundleIdentifiers,
				processIDs: expandedProcessIDs
			),
			requestedProcessIDs: uniqueProcessIDs,
			requestedWindowIDs: uniqueWindowIDs,
			matchedApplicationCount: expandedProcessIDs.count,
			matchedWindowCount: 0
		)
	}

	let availableWindowSet = Set(availableWindowIDs)
	let matchedWindowIDs = uniqueWindowIDs.filter { availableWindowSet.contains($0) }
	if !uniqueWindowIDs.isEmpty && matchedWindowIDs.count == uniqueWindowIDs.count {
		return CaptureExclusionResolution(
			strategy: .windows(windowIDs: matchedWindowIDs),
			requestedProcessIDs: uniqueProcessIDs,
			requestedWindowIDs: uniqueWindowIDs,
			matchedApplicationCount: 0,
			matchedWindowCount: matchedWindowIDs.count
		)
	}

	throw CaptureExclusionResolutionError.safeExclusionUnavailable
}
