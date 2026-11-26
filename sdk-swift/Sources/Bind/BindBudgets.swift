import Foundation
#if canImport(Network)
import Network
#endif

/// Snapshot of runtime network and power conditions affecting upload eligibility.
public struct BindUploadConditions: Sendable, Hashable {
    public var isOnline: Bool
    public var isConstrainedNetwork: Bool
    public var isLowPowerMode: Bool

    public init(
        isOnline: Bool = true,
        isConstrainedNetwork: Bool = false,
        isLowPowerMode: Bool = false
    ) {
        self.isOnline = isOnline
        self.isConstrainedNetwork = isConstrainedNetwork
        self.isLowPowerMode = isLowPowerMode
    }
}

/// Reason why uploads are currently paused while records continue queuing safely.
public enum BindUploadPauseReason: String, Sendable, Hashable {
    case offline
    case lowPowerMode
    case constrainedNetwork
    case dailyByteCapReached
}

extension BindBudgetConfiguration {
    /// Returns the active pause reason for `conditions`, or `nil` if uploads are permitted.
    public func pauseReason(for conditions: BindUploadConditions) -> BindUploadPauseReason? {
        if !conditions.isOnline {
            return .offline
        }
        if pauseInLowPowerMode && conditions.isLowPowerMode {
            return .lowPowerMode
        }
        if pauseOnConstrainedNetwork && conditions.isConstrainedNetwork {
            return .constrainedNetwork
        }
        return nil
    }
}

/// Observes connectivity, constrained-network state, and Low Power Mode.
public protocol BindEnvironmentMonitor: Sendable {
    var currentConditions: BindUploadConditions { get }
    func start(onChange: @escaping @Sendable (BindUploadConditions) -> Void)
    func stop()
}

/// Controllable environment monitor for deterministic tests and manual overrides.
public final class BindManualEnvironmentMonitor: BindEnvironmentMonitor, Sendable {
    private struct State: Sendable {
        var conditions: BindUploadConditions
        var onChange: (@Sendable (BindUploadConditions) -> Void)?
    }

    private let state: BindLockedState<State>

    public init(initial: BindUploadConditions = BindUploadConditions()) {
        self.state = BindLockedState(State(conditions: initial, onChange: nil))
    }

    public var currentConditions: BindUploadConditions {
        state.withLock { $0.conditions }
    }

    public func start(onChange: @escaping @Sendable (BindUploadConditions) -> Void) {
        state.withLock { s in
            s.onChange = onChange
        }
    }

    public func stop() {
        state.withLock { s in
            s.onChange = nil
        }
    }

    public func update(_ transform: (inout BindUploadConditions) -> Void) {
        let result: (BindUploadConditions, (@Sendable (BindUploadConditions) -> Void)?)? = state.withLock { s in
            let previous = s.conditions
            transform(&s.conditions)
            guard s.conditions != previous else {
                return nil
            }
            return (s.conditions, s.onChange)
        }
        if let (newConditions, callback) = result {
            callback?(newConditions)
        }
    }

    public func setOnline(_ online: Bool) {
        update { $0.isOnline = online }
    }

    public func setConstrainedNetwork(_ constrained: Bool) {
        update { $0.isConstrainedNetwork = constrained }
    }

    public func setLowPowerMode(_ lowPower: Bool) {
        update { $0.isLowPowerMode = lowPower }
    }
}

/// Platform-aware monitor using `NWPathMonitor` and `ProcessInfo.isLowPowerModeEnabled` on Apple
/// platforms and an online default on Linux.
public final class BindSystemEnvironmentMonitor: BindEnvironmentMonitor, @unchecked Sendable {
    private struct State {
        var conditions: BindUploadConditions
        var onChange: (@Sendable (BindUploadConditions) -> Void)?
        var started: Bool = false
        #if canImport(Network)
        var pathMonitor: NWPathMonitor?
        #endif
        #if canImport(Darwin)
        var powerObserver: NSObjectProtocol?
        #endif
    }

    private let lock = NSLock()
    private var state: State

    public init() {
        #if canImport(Darwin)
        let initialLowPower = ProcessInfo.processInfo.isLowPowerModeEnabled
        #else
        let initialLowPower = false
        #endif
        self.state = State(
            conditions: BindUploadConditions(
                isOnline: true,
                isConstrainedNetwork: false,
                isLowPowerMode: initialLowPower
            )
        )
    }

    deinit {
        stop()
    }

    public var currentConditions: BindUploadConditions {
        lock.lock()
        defer { lock.unlock() }
        return state.conditions
    }

    public func start(onChange: @escaping @Sendable (BindUploadConditions) -> Void) {
        lock.lock()
        state.onChange = onChange
        if state.started {
            lock.unlock()
            return
        }
        state.started = true

        #if canImport(Network)
        let monitor = NWPathMonitor()
        let queue = DispatchQueue(label: "dev.bind.sdk.network-monitor", qos: .utility)
        monitor.pathUpdateHandler = { [weak self] path in
            self?.handleNetworkUpdate(
                isOnline: path.status == .satisfied,
                isConstrained: path.isConstrained
            )
        }
        state.pathMonitor = monitor
        #endif

        #if canImport(Darwin)
        let observer = NotificationCenter.default.addObserver(
            forName: .NSProcessInfoPowerStateDidChange,
            object: nil,
            queue: nil
        ) { [weak self] _ in
            let lowPower = ProcessInfo.processInfo.isLowPowerModeEnabled
            self?.handlePowerUpdate(isLowPowerMode: lowPower)
        }
        state.powerObserver = observer
        #endif

        lock.unlock()

        #if canImport(Network)
        monitor.start(queue: queue)
        #endif
    }

    public func stop() {
        lock.lock()
        state.started = false
        state.onChange = nil
        #if canImport(Network)
        let monitor = state.pathMonitor
        state.pathMonitor = nil
        #endif
        #if canImport(Darwin)
        let observer = state.powerObserver
        state.powerObserver = nil
        #endif
        lock.unlock()

        #if canImport(Network)
        monitor?.cancel()
        #endif
        #if canImport(Darwin)
        if let observer {
            NotificationCenter.default.removeObserver(observer)
        }
        #endif
    }

    private func handleNetworkUpdate(isOnline: Bool, isConstrained: Bool) {
        lock.lock()
        let previous = state.conditions
        state.conditions.isOnline = isOnline
        state.conditions.isConstrainedNetwork = isConstrained
        let updated = state.conditions
        let callback = (updated != previous) ? state.onChange : nil
        lock.unlock()

        callback?(updated)
    }

    private func handlePowerUpdate(isLowPowerMode: Bool) {
        lock.lock()
        let previous = state.conditions
        state.conditions.isLowPowerMode = isLowPowerMode
        let updated = state.conditions
        let callback = (updated != previous) ? state.onChange : nil
        lock.unlock()

        callback?(updated)
    }
}

/// HTTP retry classification, `Retry-After` parsing, and jittered exponential backoff per §6.
public enum BindRetryPolicy {
    /// Section 6: only 429, 502, 503, and 504 are retryable HTTP status codes.
    public static let retryableStatusCodes: Set<Int> = [429, 502, 503, 504]

    public static func isSuccess(statusCode: Int) -> Bool {
        (200...299).contains(statusCode)
    }

    public static func isRetryable(statusCode: Int) -> Bool {
        retryableStatusCodes.contains(statusCode)
    }

    /// Parses an HTTP `Retry-After` header value (delta-seconds or IMF-fixdate/RFC 850/asctime HTTP-date).
    public static func parseRetryAfter(
        _ rawHeader: String?,
        now: Date = Date(),
        maxDelay: TimeInterval = 300.0
    ) -> TimeInterval? {
        guard let trimmed = rawHeader?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else {
            return nil
        }

        // Delta-seconds (integer or decimal)
        if let seconds = Double(trimmed), seconds.isFinite {
            return min(max(0, seconds), maxDelay)
        }

        // HTTP-date formats (RFC 9110 §5.6.7)
        let formats = [
            "EEE, dd MMM yyyy HH:mm:ss zzz",
            "EEEE, dd-MMM-yy HH:mm:ss zzz",
            "EEE MMM d HH:mm:ss yyyy",
        ]
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)

        for format in formats {
            formatter.dateFormat = format
            if let date = formatter.date(from: trimmed) {
                let delta = date.timeIntervalSince(now)
                return min(max(0, delta), maxDelay)
            }
        }
        return nil
    }

    /// Computes the next retry delay in seconds.
    ///
    /// When `retryAfter` is provided by the server, it is honored directly (clamped to `config.maxRetryAfter`).
    /// Otherwise exponential backoff with jitter is applied.
    public static func nextDelay(
        attempt: Int,
        retryAfter: TimeInterval?,
        config: BindRetryConfiguration,
        randomUnit: Double = Double.random(in: 0...1)
    ) -> TimeInterval {
        if let retryAfter, retryAfter.isFinite {
            return min(max(0, retryAfter), config.maxRetryAfter)
        }
        let clampedAttempt = max(1, attempt)
        let exponent = min(Double(clampedAttempt - 1), 20.0)
        let exponential = min(config.maxDelay, config.baseDelay * pow(2.0, exponent))
        let unit = min(max(0, randomUnit), 1)
        let minFactor = 1.0 - config.jitterFactor
        return max(0, exponential * (minFactor + config.jitterFactor * unit))
    }
}

/// Tracks per-device daily compressed upload bytes across a UTC calendar day,
/// optionally persisted alongside the offline queue so caps hold across app restarts.
internal struct BindDailyByteBudget: Sendable {
    private struct PersistedLedger: Codable, Sendable {
        var utcDayNumber: Int64
        var bytesSent: UInt64
    }

    private let ledgerURL: URL?
    private var ledger: PersistedLedger

    init(ledgerURL: URL?, now: BindTimestamp) {
        self.ledgerURL = ledgerURL
        let today = Self.utcDayNumber(for: now)
        if let ledgerURL,
           let data = try? Data(contentsOf: ledgerURL),
           let decoded = try? JSONDecoder().decode(PersistedLedger.self, from: data),
           decoded.utcDayNumber == today
        {
            self.ledger = decoded
        } else {
            self.ledger = PersistedLedger(utcDayNumber: today, bytesSent: 0)
        }
    }

    mutating func bytesUsed(now: BindTimestamp) -> UInt64 {
        rollDayIfNeeded(now: now)
        return ledger.bytesSent
    }

    mutating func canSend(bytes: Int, cap: UInt64?, now: BindTimestamp) -> Bool {
        rollDayIfNeeded(now: now)
        guard let cap else { return true }
        let requested = UInt64(max(0, bytes))
        let (sum, overflow) = ledger.bytesSent.addingReportingOverflow(requested)
        return !overflow && sum <= cap
    }

    mutating func recordSent(bytes: Int, now: BindTimestamp) {
        rollDayIfNeeded(now: now)
        let added = UInt64(max(0, bytes))
        let (sum, overflow) = ledger.bytesSent.addingReportingOverflow(added)
        ledger.bytesSent = overflow ? UInt64.max : sum
        persist()
    }

    private mutating func rollDayIfNeeded(now: BindTimestamp) {
        let today = Self.utcDayNumber(for: now)
        if ledger.utcDayNumber != today {
            ledger = PersistedLedger(utcDayNumber: today, bytesSent: 0)
            persist()
        }
    }

    private func persist() {
        guard let ledgerURL else { return }
        let dir = ledgerURL.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        if let data = try? JSONEncoder().encode(ledger) {
            try? data.write(to: ledgerURL, options: [.atomic])
        }
    }

    static func utcDayNumber(for timestamp: BindTimestamp) -> Int64 {
        let secondsPerDay: Int64 = 86_400
        if timestamp.seconds >= 0 {
            return timestamp.seconds / secondsPerDay
        }
        return (timestamp.seconds - secondsPerDay + 1) / secondsPerDay
    }
}
