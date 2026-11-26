import Foundation

/// Configuration for the size-capped persistent offline queue.
public struct BindOfflineQueueConfiguration: Sendable, Hashable {
    /// Whether sealed batches are persisted to disk for offline durability and background uploads.
    public var isEnabled: Bool

    /// Directory where persisted batch files are stored.
    /// When `nil`, defaults to a Bind subdirectory inside the app caches directory (or temp/XDG cache on Linux).
    public var directory: URL?

    /// Maximum total bytes allowed in the offline queue directory before oldest batches are evicted.
    public var maxDiskBytes: Int

    public init(
        isEnabled: Bool = true,
        directory: URL? = nil,
        maxDiskBytes: Int = 20 * 1024 * 1024
    ) {
        self.isEnabled = isEnabled
        self.directory = directory
        self.maxDiskBytes = max(1, maxDiskBytes)
    }

    public static let `default` = BindOfflineQueueConfiguration()

    public static let disabled = BindOfflineQueueConfiguration(isEnabled: false)

    /// Resolves the effective directory URL for storing offline batches.
    public func resolvedDirectory(
        fileManager: FileManager = .default,
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> URL {
        if let directory {
            return directory
        }
        #if canImport(Darwin)
        if let caches = fileManager.urls(for: .cachesDirectory, in: .userDomainMask).first {
            return caches.appendingPathComponent("dev.bind.sdk", isDirectory: true)
                .appendingPathComponent("queue", isDirectory: true)
        }
        #else
        if let xdg = environment["XDG_CACHE_HOME"], !xdg.isEmpty {
            return URL(fileURLWithPath: xdg, isDirectory: true)
                .appendingPathComponent("bind-sdk", isDirectory: true)
                .appendingPathComponent("queue", isDirectory: true)
        }
        #endif
        return fileManager.temporaryDirectory
            .appendingPathComponent("dev.bind.sdk", isDirectory: true)
            .appendingPathComponent("queue", isDirectory: true)
    }
}

/// Configuration for retry backoff, jitter, and `Retry-After` handling.
public struct BindRetryConfiguration: Sendable, Hashable {
    /// Initial exponential backoff delay in seconds before jitter.
    public var baseDelay: TimeInterval

    /// Maximum exponential backoff delay in seconds.
    public var maxDelay: TimeInterval

    /// Jitter fraction in `0.0...1.0`. Delay is sampled in `[expDelay * (1 - jitterFactor), expDelay]`.
    public var jitterFactor: Double

    /// Upper bound for server-supplied `Retry-After` delays in seconds.
    public var maxRetryAfter: TimeInterval

    /// Per-request HTTP timeout in seconds.
    public var requestTimeout: TimeInterval

    public init(
        baseDelay: TimeInterval = 1.0,
        maxDelay: TimeInterval = 60.0,
        jitterFactor: Double = 0.5,
        maxRetryAfter: TimeInterval = 300.0,
        requestTimeout: TimeInterval = 30.0
    ) {
        self.baseDelay = max(0, baseDelay)
        self.maxDelay = max(self.baseDelay, maxDelay)
        self.jitterFactor = min(max(0, jitterFactor), 1)
        self.maxRetryAfter = max(0, maxRetryAfter)
        self.requestTimeout = max(0.1, requestTimeout)
    }

    public static let `default` = BindRetryConfiguration()
}

/// Device power, network, and daily byte upload budget settings.
public struct BindBudgetConfiguration: Sendable, Hashable {
    /// Pause uploads while the device is in Low Power Mode unless explicitly overridden.
    public var pauseInLowPowerMode: Bool

    /// Pause uploads while the active network path is constrained (Low Data Mode) unless overridden.
    public var pauseOnConstrainedNetwork: Bool

    /// Optional per-device daily compressed upload byte cap (UTC day). `nil` disables the daily cap.
    public var dailyByteCap: UInt64?

    public init(
        pauseInLowPowerMode: Bool = true,
        pauseOnConstrainedNetwork: Bool = true,
        dailyByteCap: UInt64? = nil
    ) {
        self.pauseInLowPowerMode = pauseInLowPowerMode
        self.pauseOnConstrainedNetwork = pauseOnConstrainedNetwork
        self.dailyByteCap = dailyByteCap
    }

    public static let `default` = BindBudgetConfiguration()
}

/// Resolves SDK identity defaults (`service`, `env`, `release`, `endpoint`) from environment and app bundle.
public enum BindEnvironmentDefaults {
    public static let defaultEndpoint = URL(string: "https://ingest.bind.dev")!

    public static func resolveService(
        explicit: String? = nil,
        environment: [String: String] = ProcessInfo.processInfo.environment,
        bundleIdentifier: String? = Bundle.main.bundleIdentifier,
        bundleName: String? = Bundle.main.object(forInfoDictionaryKey: "CFBundleName") as? String,
        processName: String = ProcessInfo.processInfo.processName
    ) -> String {
        if let value = nonEmpty(explicit) { return value }
        if let value = nonEmpty(environment["BIND_SERVICE"]) { return value }
        if let value = nonEmpty(bundleIdentifier) { return value }
        if let value = nonEmpty(bundleName) { return value }
        if let value = nonEmpty(processName) { return value }
        return "unknown"
    }

    public static func resolveEnv(
        explicit: String? = nil,
        environment: [String: String] = ProcessInfo.processInfo.environment,
        bundleEnvironment: String? = Bundle.main.object(forInfoDictionaryKey: "BindEnvironment") as? String
    ) -> String {
        if let value = nonEmpty(explicit) { return value }
        if let value = nonEmpty(environment["BIND_ENV"]) { return value }
        if let value = nonEmpty(bundleEnvironment) { return value }
        #if DEBUG
        return "development"
        #else
        return "production"
        #endif
    }

    public static func resolveRelease(
        explicit: String? = nil,
        environment: [String: String] = ProcessInfo.processInfo.environment,
        shortVersion: String? = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String,
        buildVersion: String? = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String
    ) -> String {
        if let value = nonEmpty(explicit) { return value }
        if let value = nonEmpty(environment["BIND_RELEASE"]) { return value }
        let short = nonEmpty(shortVersion)
        let build = nonEmpty(buildVersion)
        switch (short, build) {
        case let (s?, b?) where s != b:
            return "\(s)+\(b)"
        case let (s?, _):
            return s
        case let (nil, b?):
            return b
        case (nil, nil):
            return "unknown"
        }
    }

    public static func resolveEndpoint(
        explicit: URL? = nil,
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> URL {
        if let explicit { return explicit }
        if let raw = nonEmpty(environment["BIND_ENDPOINT"]), let parsed = URL(string: raw) {
            return parsed
        }
        return defaultEndpoint
    }

    /// Normalizes a base or full endpoint URL so it targets `POST /v1/batch`.
    public static func normalizeBatchEndpoint(_ url: URL) -> URL {
        let trimmedPath = url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        if trimmedPath.isEmpty {
            return url.appendingPathComponent("v1").appendingPathComponent("batch")
        }
        if url.path.hasSuffix(BindProtocol.batchPath) {
            return url
        }
        return url.appendingPathComponent("v1").appendingPathComponent("batch")
    }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else {
            return nil
        }
        return trimmed
    }
}

/// Complete configuration for `BindClient` and `Bind.start(...)`.
public struct BindConfiguration: Sendable, Hashable {
    public static let defaultMaxBatchRecords = 500
    public static let defaultMaxBatchCompressedBytes = 256 * 1024
    public static let defaultFlushInterval: TimeInterval = 5.0
    public static let defaultMaxMemoryQueueBytes = 4 * 1024 * 1024

    public var ingestKey: String
    public var service: String
    public var env: String
    public var release: String
    public var endpoint: URL
    public var maxBatchRecords: Int
    public var maxBatchCompressedBytes: Int
    public var flushInterval: TimeInterval
    public var maxMemoryQueueBytes: Int
    public var offlineQueue: BindOfflineQueueConfiguration
    public var retry: BindRetryConfiguration
    public var budgets: BindBudgetConfiguration
    public var backgroundSessionIdentifier: String
    public var enableLifecycleFlush: Bool

    public init(
        ingestKey: String,
        service: String? = nil,
        env: String? = nil,
        release: String? = nil,
        endpoint: URL? = nil,
        maxBatchRecords: Int = BindConfiguration.defaultMaxBatchRecords,
        maxBatchCompressedBytes: Int = BindConfiguration.defaultMaxBatchCompressedBytes,
        flushInterval: TimeInterval = BindConfiguration.defaultFlushInterval,
        maxMemoryQueueBytes: Int = BindConfiguration.defaultMaxMemoryQueueBytes,
        offlineQueue: BindOfflineQueueConfiguration = .default,
        retry: BindRetryConfiguration = .default,
        budgets: BindBudgetConfiguration = .default,
        backgroundSessionIdentifier: String? = nil,
        enableLifecycleFlush: Bool = true
    ) {
        let resolvedService = BindEnvironmentDefaults.resolveService(explicit: service)
        self.ingestKey = ingestKey
        self.service = resolvedService
        self.env = BindEnvironmentDefaults.resolveEnv(explicit: env)
        self.release = BindEnvironmentDefaults.resolveRelease(explicit: release)
        self.endpoint = BindEnvironmentDefaults.resolveEndpoint(explicit: endpoint)
        self.maxBatchRecords = max(1, maxBatchRecords)
        self.maxBatchCompressedBytes = max(128, maxBatchCompressedBytes)
        self.flushInterval = max(0.01, flushInterval)
        self.maxMemoryQueueBytes = max(128, maxMemoryQueueBytes)
        self.offlineQueue = offlineQueue
        self.retry = retry
        self.budgets = budgets
        let sanitizedService = resolvedService.replacingOccurrences(of: "/", with: ".")
        self.backgroundSessionIdentifier = backgroundSessionIdentifier ?? "dev.bind.sdk.upload.\(sanitizedService)"
        self.enableLifecycleFlush = enableLifecycleFlush
    }

    /// Full target URL for `POST /v1/batch`.
    public var batchEndpointURL: URL {
        BindEnvironmentDefaults.normalizeBatchEndpoint(endpoint)
    }
}
