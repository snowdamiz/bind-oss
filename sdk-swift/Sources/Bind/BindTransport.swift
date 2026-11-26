import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Classified outcome of attempting to upload a prepared batch.
public enum BindUploadOutcome: Sendable, Hashable {
    case success(statusCode: Int)
    case retryable(statusCode: Int?, retryAfter: TimeInterval?, reason: String)
    case permanentFailure(statusCode: Int, reason: String)
}

/// Transport abstraction for foreground and background batch uploads.
public protocol BindBatchTransport: Sendable {
    /// Sends an immutable prepared batch over HTTP.
    func send(batch: BindPreparedBatch, request: URLRequest) async -> BindUploadOutcome

    /// Attempts to schedule a background upload from an on-disk `.bin.gz` file.
    ///
    /// Returns `true` when the transfer has been accepted by a background session
    /// (which will later invoke `onComplete`), or `false` if background upload is unavailable
    /// on this platform and the caller should fall back to foreground delivery.
    func enqueueBackgroundUpload(
        batch: BindPreparedBatch,
        fileURL: URL,
        request: URLRequest,
        onComplete: @escaping @Sendable (UUID, BindUploadOutcome) -> Void
    ) -> Bool

    /// Connects an Apple app delegate's `handleEventsForBackgroundURLSession` completion handler.
    func handleBackgroundSessionEvents(
        identifier: String,
        completionHandler: @escaping @Sendable () -> Void
    )

    /// Releases underlying network sessions during shutdown.
    func invalidate()
}

public extension BindBatchTransport {
    func enqueueBackgroundUpload(
        batch: BindPreparedBatch,
        fileURL: URL,
        request: URLRequest,
        onComplete: @escaping @Sendable (UUID, BindUploadOutcome) -> Void
    ) -> Bool {
        false
    }

    func handleBackgroundSessionEvents(
        identifier: String,
        completionHandler: @escaping @Sendable () -> Void
    ) {
        completionHandler()
    }

    func invalidate() {}
}

/// Default `URLSession`-backed transport for Apple platforms and Linux (`FoundationNetworking`).
public final class BindURLSessionTransport: BindBatchTransport, @unchecked Sendable {
    private let foregroundSession: URLSession
    private let maxRetryAfter: TimeInterval
    #if canImport(Darwin)
    private let backgroundController: BindBackgroundSessionController
    #endif

    public init(configuration: BindConfiguration) {
        let fgConfig = URLSessionConfiguration.ephemeral
        fgConfig.timeoutIntervalForRequest = configuration.retry.requestTimeout
        fgConfig.timeoutIntervalForResource = max(configuration.retry.requestTimeout * 2, 60)
        fgConfig.httpShouldSetCookies = false
        fgConfig.urlCache = nil
        #if canImport(Darwin)
        fgConfig.allowsConstrainedNetworkAccess = !configuration.budgets.pauseOnConstrainedNetwork
        #endif
        self.foregroundSession = URLSession(configuration: fgConfig)
        self.maxRetryAfter = configuration.retry.maxRetryAfter

        #if canImport(Darwin)
        self.backgroundController = BindBackgroundSessionController(
            identifier: configuration.backgroundSessionIdentifier,
            allowsConstrainedNetworkAccess: !configuration.budgets.pauseOnConstrainedNetwork,
            maxRetryAfter: configuration.retry.maxRetryAfter
        )
        #endif
    }

    public func send(batch: BindPreparedBatch, request: URLRequest) async -> BindUploadOutcome {
        let maxRetryAfter = self.maxRetryAfter
        return await withCheckedContinuation { continuation in
            let task = foregroundSession.uploadTask(with: request, from: batch.compressedPayload) { _, response, error in
                let outcome = Self.classify(
                    response: response,
                    error: error,
                    maxRetryAfter: maxRetryAfter
                )
                continuation.resume(returning: outcome)
            }
            task.resume()
        }
    }

    public func enqueueBackgroundUpload(
        batch: BindPreparedBatch,
        fileURL: URL,
        request: URLRequest,
        onComplete: @escaping @Sendable (UUID, BindUploadOutcome) -> Void
    ) -> Bool {
        #if canImport(Darwin)
        return backgroundController.enqueueUpload(
            batchID: batch.batchID,
            fileURL: fileURL,
            request: request,
            onComplete: onComplete
        )
        #else
        return false
        #endif
    }

    public func handleBackgroundSessionEvents(
        identifier: String,
        completionHandler: @escaping @Sendable () -> Void
    ) {
        #if canImport(Darwin)
        backgroundController.handleBackgroundSessionEvents(
            identifier: identifier,
            completionHandler: completionHandler
        )
        #else
        completionHandler()
        #endif
    }

    public func invalidate() {
        foregroundSession.invalidateAndCancel()
        #if canImport(Darwin)
        backgroundController.invalidate()
        #endif
    }

    /// Classifies an HTTP response or transport error into a `BindUploadOutcome`.
    public static func classify(
        response: URLResponse?,
        error: (any Error)?,
        maxRetryAfter: TimeInterval,
        now: Date = Date()
    ) -> BindUploadOutcome {
        if let error {
            return .retryable(
                statusCode: nil,
                retryAfter: nil,
                reason: error.localizedDescription
            )
        }
        guard let http = response as? HTTPURLResponse else {
            return .retryable(
                statusCode: nil,
                retryAfter: nil,
                reason: "Unexpected non-HTTP response"
            )
        }

        let code = http.statusCode
        if BindRetryPolicy.isSuccess(statusCode: code) {
            return .success(statusCode: code)
        }
        if BindRetryPolicy.isRetryable(statusCode: code) {
            let retryAfterHeader = Self.headerValue(named: "Retry-After", in: http)
            let retryAfter = BindRetryPolicy.parseRetryAfter(
                retryAfterHeader,
                now: now,
                maxDelay: maxRetryAfter
            )
            return .retryable(
                statusCode: code,
                retryAfter: retryAfter,
                reason: "HTTP \(code)"
            )
        }
        return .permanentFailure(statusCode: code, reason: "HTTP \(code)")
    }

    private static func headerValue(named target: String, in response: HTTPURLResponse) -> String? {
        #if canImport(Darwin)
        if let direct = response.value(forHTTPHeaderField: target) {
            return direct
        }
        #endif
        let lowerTarget = target.lowercased()
        for (rawKey, rawValue) in response.allHeaderFields {
            if String(describing: rawKey).lowercased() == lowerTarget {
                return String(describing: rawValue)
            }
        }
        return nil
    }
}

#if canImport(Darwin)
/// Manages an Apple background `URLSession` for file-based final-batch uploads across app suspension.
internal final class BindBackgroundSessionController: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    private let identifier: String
    private let allowsConstrainedNetworkAccess: Bool
    private let maxRetryAfter: TimeInterval
    private let lock = NSLock()

    private var session: URLSession?
    private var completionsByBatchID: [UUID: @Sendable (UUID, BindUploadOutcome) -> Void] = [:]
    private var systemCompletionHandler: (@Sendable () -> Void)?
    private var invalidated = false

    init(
        identifier: String,
        allowsConstrainedNetworkAccess: Bool,
        maxRetryAfter: TimeInterval
    ) {
        self.identifier = identifier
        self.allowsConstrainedNetworkAccess = allowsConstrainedNetworkAccess
        self.maxRetryAfter = maxRetryAfter
        super.init()
    }

    func enqueueUpload(
        batchID: UUID,
        fileURL: URL,
        request: URLRequest,
        onComplete: @escaping @Sendable (UUID, BindUploadOutcome) -> Void
    ) -> Bool {
        guard FileManager.default.fileExists(atPath: fileURL.path) else {
            return false
        }

        let activeSession: URLSession? = {
            lock.lock()
            defer { lock.unlock() }
            guard !invalidated else { return nil }
            let resolved = getOrCreateSessionLocked()
            completionsByBatchID[batchID] = onComplete
            return resolved
        }()

        guard let activeSession else { return false }

        let task = activeSession.uploadTask(with: request, fromFile: fileURL)
        task.taskDescription = batchID.uuidString
        task.resume()
        return true
    }

    func handleBackgroundSessionEvents(
        identifier: String,
        completionHandler: @escaping @Sendable () -> Void
    ) {
        guard identifier == self.identifier else {
            completionHandler()
            return
        }
        lock.lock()
        guard !invalidated else {
            lock.unlock()
            completionHandler()
            return
        }
        _ = getOrCreateSessionLocked()
        systemCompletionHandler = completionHandler
        lock.unlock()
    }

    func invalidate() {
        lock.lock()
        invalidated = true
        let activeSession = session
        session = nil
        let pendingCompletions = completionsByBatchID
        completionsByBatchID.removeAll()
        let sysHandler = systemCompletionHandler
        systemCompletionHandler = nil
        lock.unlock()

        activeSession?.finishTasksAndInvalidate()
        for (batchID, callback) in pendingCompletions {
            callback(batchID, .retryable(statusCode: nil, retryAfter: nil, reason: "Background session invalidated"))
        }
        sysHandler?()
    }

    private func getOrCreateSessionLocked() -> URLSession {
        if let existing = session {
            return existing
        }
        let config = URLSessionConfiguration.background(withIdentifier: identifier)
        config.isDiscretionary = false
        config.sessionSendsLaunchEvents = true
        config.allowsConstrainedNetworkAccess = allowsConstrainedNetworkAccess
        config.httpShouldSetCookies = false
        config.urlCache = nil
        let created = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        session = created
        return created
    }

    // MARK: - URLSessionTaskDelegate

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?) {
        let outcome = BindURLSessionTransport.classify(
            response: task.response,
            error: error,
            maxRetryAfter: maxRetryAfter
        )
        guard let rawID = task.taskDescription, let batchID = UUID(uuidString: rawID) else {
            return
        }

        let callback: (@Sendable (UUID, BindUploadOutcome) -> Void)? = {
            lock.lock()
            defer { lock.unlock() }
            return completionsByBatchID.removeValue(forKey: batchID)
        }()

        callback?(batchID, outcome)
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        let handler: (@Sendable () -> Void)? = {
            lock.lock()
            defer { lock.unlock() }
            let h = systemCompletionHandler
            systemCompletionHandler = nil
            return h
        }()
        if let handler {
            DispatchQueue.main.async {
                handler()
            }
        }
    }
}
#endif
