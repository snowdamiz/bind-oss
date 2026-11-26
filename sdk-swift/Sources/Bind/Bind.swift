import Foundation

/// A thread-safe sink that receives captured `BindRecord` values without throwing or blocking.
public protocol BindRecordSink: Sendable {
    func receive(_ record: BindRecord)
}

/// A thread-safe in-memory sink useful for testing and inspection.
public final class BindMemorySink: BindRecordSink, @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [BindRecord] = []

    public init() {}

    public func receive(_ record: BindRecord) {
        lock.lock()
        storage.append(record)
        lock.unlock()
    }

    public var records: [BindRecord] {
        lock.lock()
        let copy = storage
        lock.unlock()
        return copy
    }

    public func removeAll() {
        lock.lock()
        storage.removeAll()
        lock.unlock()
    }
}

/// Internal lock-protected box compatible with iOS 15, macOS 12, and Linux under Swift 6 concurrency.
internal final class BindLockedState<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Value

    init(_ initialValue: Value) {
        self.value = initialValue
    }

    func withLock<R>(_ body: (inout Value) -> R) -> R {
        lock.lock()
        defer { lock.unlock() }
        return body(&value)
    }
}

/// Sink that forwards records to the currently installed global sink on `Bind`.
private struct BindGlobalSink: BindRecordSink {
    func receive(_ record: BindRecord) {
        let sink = Bind.globalSink.withLock { $0 }
        sink?.receive(record)
    }
}

/// Primary logger interface for emitting interpolated and structured `BindRecord` values.
public struct BindLogger: Sendable {
    private let sink: any BindRecordSink
    private let clock: @Sendable () -> BindTimestamp
    private let defaultAttrs: [String: String]

    public init(
        sink: any BindRecordSink,
        defaultAttrs: [String: String] = [:],
        clock: @escaping @Sendable () -> BindTimestamp = BindTimestamp.now
    ) {
        self.sink = sink
        self.defaultAttrs = defaultAttrs
        self.clock = clock
    }

    /// Returns a child logger that merges `attrs` onto every emitted record.
    /// Per-call attributes override logger default attributes on key collision.
    public func with(attrs: [String: String]) -> BindLogger {
        var merged = defaultAttrs
        for (key, value) in attrs {
            merged[key] = value
        }
        return BindLogger(sink: sink, defaultAttrs: merged, clock: clock)
    }

    /// Emits a pre-constructed record directly to the sink.
    public func emit(_ record: BindRecord) {
        sink.receive(record)
    }

    // MARK: - Interpolated message logging

    public func log(
        severity: BindSeverity,
        _ message: BindMessage,
        attrs: [String: String]? = nil,
        traceID: String? = nil,
        spanID: String? = nil,
        file: String = #fileID,
        line: UInt = #line,
        function: String = #function
    ) {
        let record = BindRecord(
            ts: clock(),
            severity: severity,
            body: .string(message.rendered),
            tpl: message.template,
            callsite: BindCallsite(file: file, line: line, function: function),
            attrs: mergedAttrs(attrs),
            traceID: traceID,
            spanID: spanID
        )
        sink.receive(record)
    }

    public func trace(
        _ message: BindMessage,
        attrs: [String: String]? = nil,
        traceID: String? = nil,
        spanID: String? = nil,
        file: String = #fileID,
        line: UInt = #line,
        function: String = #function
    ) {
        log(
            severity: .trace,
            message,
            attrs: attrs,
            traceID: traceID,
            spanID: spanID,
            file: file,
            line: line,
            function: function
        )
    }

    public func debug(
        _ message: BindMessage,
        attrs: [String: String]? = nil,
        traceID: String? = nil,
        spanID: String? = nil,
        file: String = #fileID,
        line: UInt = #line,
        function: String = #function
    ) {
        log(
            severity: .debug,
            message,
            attrs: attrs,
            traceID: traceID,
            spanID: spanID,
            file: file,
            line: line,
            function: function
        )
    }

    public func info(
        _ message: BindMessage,
        attrs: [String: String]? = nil,
        traceID: String? = nil,
        spanID: String? = nil,
        file: String = #fileID,
        line: UInt = #line,
        function: String = #function
    ) {
        log(
            severity: .info,
            message,
            attrs: attrs,
            traceID: traceID,
            spanID: spanID,
            file: file,
            line: line,
            function: function
        )
    }

    public func notice(
        _ message: BindMessage,
        attrs: [String: String]? = nil,
        traceID: String? = nil,
        spanID: String? = nil,
        file: String = #fileID,
        line: UInt = #line,
        function: String = #function
    ) {
        log(
            severity: .notice,
            message,
            attrs: attrs,
            traceID: traceID,
            spanID: spanID,
            file: file,
            line: line,
            function: function
        )
    }

    public func warn(
        _ message: BindMessage,
        attrs: [String: String]? = nil,
        traceID: String? = nil,
        spanID: String? = nil,
        file: String = #fileID,
        line: UInt = #line,
        function: String = #function
    ) {
        log(
            severity: .warn,
            message,
            attrs: attrs,
            traceID: traceID,
            spanID: spanID,
            file: file,
            line: line,
            function: function
        )
    }

    public func warning(
        _ message: BindMessage,
        attrs: [String: String]? = nil,
        traceID: String? = nil,
        spanID: String? = nil,
        file: String = #fileID,
        line: UInt = #line,
        function: String = #function
    ) {
        log(
            severity: .warn,
            message,
            attrs: attrs,
            traceID: traceID,
            spanID: spanID,
            file: file,
            line: line,
            function: function
        )
    }

    public func error(
        _ message: BindMessage,
        attrs: [String: String]? = nil,
        traceID: String? = nil,
        spanID: String? = nil,
        file: String = #fileID,
        line: UInt = #line,
        function: String = #function
    ) {
        log(
            severity: .error,
            message,
            attrs: attrs,
            traceID: traceID,
            spanID: spanID,
            file: file,
            line: line,
            function: function
        )
    }

    public func fatal(
        _ message: BindMessage,
        attrs: [String: String]? = nil,
        traceID: String? = nil,
        spanID: String? = nil,
        file: String = #fileID,
        line: UInt = #line,
        function: String = #function
    ) {
        log(
            severity: .fatal,
            message,
            attrs: attrs,
            traceID: traceID,
            spanID: spanID,
            file: file,
            line: line,
            function: function
        )
    }

    public func critical(
        _ message: BindMessage,
        attrs: [String: String]? = nil,
        traceID: String? = nil,
        spanID: String? = nil,
        file: String = #fileID,
        line: UInt = #line,
        function: String = #function
    ) {
        log(
            severity: .fatal,
            message,
            attrs: attrs,
            traceID: traceID,
            spanID: spanID,
            file: file,
            line: line,
            function: function
        )
    }

    // MARK: - Structured JSON body logging (no template)

    public func log(
        severity: BindSeverity,
        body: BindValue,
        attrs: [String: String]? = nil,
        traceID: String? = nil,
        spanID: String? = nil,
        file: String = #fileID,
        line: UInt = #line,
        function: String = #function
    ) {
        let record = BindRecord(
            ts: clock(),
            severity: severity,
            body: body,
            tpl: nil,
            callsite: BindCallsite(file: file, line: line, function: function),
            attrs: mergedAttrs(attrs),
            traceID: traceID,
            spanID: spanID
        )
        sink.receive(record)
    }

    private func mergedAttrs(_ callAttrs: [String: String]?) -> [String: String]? {
        if defaultAttrs.isEmpty {
            guard let callAttrs, !callAttrs.isEmpty else {
                return nil
            }
            return callAttrs
        }
        guard let callAttrs, !callAttrs.isEmpty else {
            return defaultAttrs
        }
        var merged = defaultAttrs
        for (key, value) in callAttrs {
            merged[key] = value
        }
        return merged
    }
}

/// Top-level entry point for the Bind Swift SDK.
public enum Bind {
    fileprivate static let globalSink = BindLockedState<(any BindRecordSink)?>(nil)
    private static let globalClient = BindLockedState<BindClient?>(nil)

    /// Shared logger forwarding to the currently installed global sink.
    public static let log = BindLogger(sink: BindGlobalSink())

    /// Currently active global `BindClient` started via `Bind.start(...)`, if any.
    public static var client: BindClient? {
        globalClient.withLock { $0 }
    }

    /// Starts the Bind SDK with a single setup call and installs it as the active sink for `Bind.log`.
    @discardableResult
    public static func start(
        key: String,
        service: String? = nil,
        env: String? = nil,
        release: String? = nil,
        endpoint: URL? = nil,
        budgets: BindBudgetConfiguration = .default,
        offlineQueue: BindOfflineQueueConfiguration = .default
    ) -> BindClient {
        let config = BindConfiguration(
            ingestKey: key,
            service: service,
            env: env,
            release: release,
            endpoint: endpoint,
            offlineQueue: offlineQueue,
            budgets: budgets
        )
        return start(configuration: config)
    }

    /// Starts the Bind SDK with an explicit configuration and optional transport/environment overrides.
    @discardableResult
    public static func start(
        configuration: BindConfiguration,
        transport: (any BindBatchTransport)? = nil,
        environmentMonitor: (any BindEnvironmentMonitor)? = nil
    ) -> BindClient {
        let newClient = BindClient(
            configuration: configuration,
            transport: transport,
            environmentMonitor: environmentMonitor
        )
        let previous = globalClient.withLock { current -> BindClient? in
            let old = current
            current = newClient
            return old
        }
        previous?.cancelSynchronously()
        globalSink.withLock { $0 = newClient }
        return newClient
    }

    /// Seals and flushes all pending records on the active global client.
    public static func flush() async {
        let current = globalClient.withLock { $0 }
        await current?.flush()
    }

    /// Seals pending records to disk and hands off eligible batches to background `URLSession` upload.
    public static func flushForBackground() async {
        let current = globalClient.withLock { $0 }
        await current?.handleDidEnterBackground()
    }

    /// Forwards an Apple app delegate's `handleEventsForBackgroundURLSession` callback to the active client.
    public static func handleBackgroundSessionEvents(
        identifier: String,
        completionHandler: @escaping @Sendable () -> Void
    ) {
        let current = globalClient.withLock { $0 }
        if let current {
            current.handleBackgroundSessionEvents(
                identifier: identifier,
                completionHandler: completionHandler
            )
        } else {
            completionHandler()
        }
    }

    /// Flushes and shuts down the active global client, detaching it from `Bind.log`.
    public static func shutdown() async {
        let previous = globalClient.withLock { current -> BindClient? in
            let old = current
            current = nil
            return old
        }
        globalSink.withLock { $0 = nil }
        await previous?.shutdown()
    }

    /// Installs the global sink used by `Bind.log`.
    public static func setSink(_ sink: (any BindRecordSink)?) {
        let previous = globalClient.withLock { current -> BindClient? in
            let old = current
            current = nil
            return old
        }
        previous?.cancelSynchronously()
        globalSink.withLock { $0 = sink }
    }

    /// Removes any installed global sink and cancels any active global client.
    public static func reset() {
        setSink(nil)
    }
}
