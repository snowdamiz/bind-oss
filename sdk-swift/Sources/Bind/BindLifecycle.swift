import Foundation
#if canImport(UIKit) && !os(watchOS)
import UIKit
#elseif canImport(AppKit) && !targetEnvironment(macCatalyst)
import AppKit
#endif

/// Platform-gated app lifecycle observer that triggers background flush on Apple platforms
/// and acts as a zero-dependency no-op on Linux.
internal final class BindLifecycleObserver: @unchecked Sendable {
    private let lock = NSLock()
    private var tokens: [NSObjectProtocol] = []

    init() {}

    deinit {
        stop()
    }

    func start(
        onBackground: @escaping @Sendable () async -> Void,
        onTerminate: @escaping @Sendable () async -> Void
    ) {
        stop()

        #if canImport(UIKit) && !os(watchOS)
        let center = NotificationCenter.default
        let bgToken = center.addObserver(
            forName: UIApplication.didEnterBackgroundNotification,
            object: nil,
            queue: nil
        ) { _ in
            Task { @MainActor in
                var taskID: UIBackgroundTaskIdentifier = .invalid
                let finish: @MainActor () -> Void = {
                    if taskID != .invalid {
                        let idToEnd = taskID
                        taskID = .invalid
                        UIApplication.shared.endBackgroundTask(idToEnd)
                    }
                }
                taskID = UIApplication.shared.beginBackgroundTask(withName: "dev.bind.sdk.lifecycle-flush") {
                    Task { @MainActor in
                        finish()
                    }
                }
                await onBackground()
                finish()
            }
        }
        let termToken = center.addObserver(
            forName: UIApplication.willTerminateNotification,
            object: nil,
            queue: nil
        ) { _ in
            Task {
                await onTerminate()
            }
        }
        lock.lock()
        tokens = [bgToken, termToken]
        lock.unlock()

        #elseif canImport(AppKit) && !targetEnvironment(macCatalyst)
        let center = NotificationCenter.default
        let resignToken = center.addObserver(
            forName: NSApplication.willResignActiveNotification,
            object: nil,
            queue: nil
        ) { _ in
            Task {
                await onBackground()
            }
        }
        let termToken = center.addObserver(
            forName: NSApplication.willTerminateNotification,
            object: nil,
            queue: nil
        ) { _ in
            Task {
                await onTerminate()
            }
        }
        lock.lock()
        tokens = [resignToken, termToken]
        lock.unlock()
        #else
        _ = onBackground
        _ = onTerminate
        #endif
    }

    func stop() {
        lock.lock()
        let activeTokens = tokens
        tokens.removeAll()
        lock.unlock()

        for token in activeTokens {
            NotificationCenter.default.removeObserver(token)
        }
    }
}
