import Foundation
@testable import Bind
#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#elseif canImport(Musl)
import Musl
#endif

/// Scripted HTTP response emitted by `FakeBindServer`.
struct FakeServerResponse: Sendable {
    let statusCode: Int
    let reasonPhrase: String
    let headers: [String: String]
    let body: String
    let delaySeconds: TimeInterval
    let closeWithoutResponse: Bool

    init(
        statusCode: Int = 200,
        reasonPhrase: String? = nil,
        headers: [String: String] = [:],
        body: String = "{\"ok\":true}",
        delaySeconds: TimeInterval = 0,
        closeWithoutResponse: Bool = false
    ) {
        self.statusCode = statusCode
        self.reasonPhrase = reasonPhrase ?? Self.defaultReason(for: statusCode)
        self.headers = headers
        self.body = body
        self.delaySeconds = delaySeconds
        self.closeWithoutResponse = closeWithoutResponse
    }

    private static func defaultReason(for code: Int) -> String {
        switch code {
        case 200: return "OK"
        case 202: return "Accepted"
        case 400: return "Bad Request"
        case 401: return "Unauthorized"
        case 429: return "Too Many Requests"
        case 500: return "Internal Server Error"
        case 502: return "Bad Gateway"
        case 503: return "Service Unavailable"
        case 504: return "Gateway Timeout"
        default: return "Status \(code)"
        }
    }
}

/// Captured HTTP request received by `FakeBindServer`.
struct FakeServerCapturedRequest: Sendable {
    let method: String
    let path: String
    let headers: [String: String]
    let rawBody: Data
    let decompressedBody: Data?
    let envelope: BindBatchEnvelope?
    let receivedAt: Date
    let statusCodeSent: Int
}

/// Real local HTTP/1.1 server over POSIX TCP loopback (`127.0.0.1:0`) with zero external dependencies.
/// Works identically on macOS, iOS Simulator, and Linux.
final class FakeBindServer: @unchecked Sendable {
    private let listenFD: Int32
    let port: UInt16
    let baseURL: URL

    private let lock = NSLock()
    private var stopped = false
    private var capturedRequests: [FakeServerCapturedRequest] = []
    private var scriptedResponses: [FakeServerResponse] = []
    private var defaultResponse = FakeServerResponse(statusCode: 200)
    private var responseHandler: (@Sendable (FakeServerCapturedRequest) -> FakeServerResponse)?

    private let acceptQueue = DispatchQueue(label: "dev.bind.tests.fake-server.accept", qos: .userInitiated)
    private let workerQueue = DispatchQueue(label: "dev.bind.tests.fake-server.worker", qos: .userInitiated, attributes: .concurrent)

    init() throws {
        #if canImport(Glibc)
        let sockType = Int32(SOCK_STREAM.rawValue)
        #else
        let sockType = SOCK_STREAM
        #endif
        let fd = socket(AF_INET, sockType, 0)
        guard fd >= 0 else {
            throw NSError(domain: "FakeBindServer", code: Int(errno), userInfo: [NSLocalizedDescriptionKey: "socket() failed"])
        }

        var reuse: Int32 = 1
        _ = setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &reuse, socklen_t(MemoryLayout<Int32>.size))

        var addr = sockaddr_in()
        #if canImport(Darwin)
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        #endif
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = 0 // Ephemeral OS-assigned port
        addr.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))

        let bindResult = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockPtr in
                bind(fd, sockPtr, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bindResult == 0 else {
            close(fd)
            throw NSError(domain: "FakeBindServer", code: Int(errno), userInfo: [NSLocalizedDescriptionKey: "bind() failed"])
        }

        guard listen(fd, 64) == 0 else {
            close(fd)
            throw NSError(domain: "FakeBindServer", code: Int(errno), userInfo: [NSLocalizedDescriptionKey: "listen() failed"])
        }

        var boundAddr = sockaddr_in()
        var boundLen = socklen_t(MemoryLayout<sockaddr_in>.size)
        let nameResult = withUnsafeMutablePointer(to: &boundAddr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockPtr in
                getsockname(fd, sockPtr, &boundLen)
            }
        }
        guard nameResult == 0 else {
            close(fd)
            throw NSError(domain: "FakeBindServer", code: Int(errno), userInfo: [NSLocalizedDescriptionKey: "getsockname() failed"])
        }

        self.listenFD = fd
        self.port = UInt16(bigEndian: boundAddr.sin_port)
        self.baseURL = URL(string: "http://127.0.0.1:\(self.port)")!

        startAcceptLoop()
    }

    deinit {
        stop()
    }

    func stop() {
        lock.lock()
        let alreadyStopped = stopped
        stopped = true
        lock.unlock()

        if !alreadyStopped {
            #if canImport(Darwin)
            _ = Darwin.shutdown(listenFD, SHUT_RDWR)
            #elseif canImport(Glibc)
            _ = Glibc.shutdown(listenFD, Int32(SHUT_RDWR))
            #elseif canImport(Musl)
            _ = Musl.shutdown(listenFD, Int32(SHUT_RDWR))
            #endif
            close(listenFD)
        }
    }

    func enqueueResponses(_ responses: [FakeServerResponse]) {
        lock.lock()
        scriptedResponses.append(contentsOf: responses)
        lock.unlock()
    }

    func setDefaultResponse(_ response: FakeServerResponse) {
        lock.lock()
        defaultResponse = response
        lock.unlock()
    }

    func setResponseHandler(_ handler: (@Sendable (FakeServerCapturedRequest) -> FakeServerResponse)?) {
        lock.lock()
        responseHandler = handler
        lock.unlock()
    }

    var requests: [FakeServerCapturedRequest] {
        lock.lock()
        defer { lock.unlock() }
        return capturedRequests
    }

    func resetRequests() {
        lock.lock()
        capturedRequests.removeAll()
        lock.unlock()
    }

    /// Waits until at least `expectedCount` requests have been received or `timeout` elapses.
    func waitForRequests(count expectedCount: Int, timeout: TimeInterval = 5.0) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if requests.count >= expectedCount {
                return true
            }
            try? await Task.sleep(nanoseconds: 15_000_000)
        }
        return requests.count >= expectedCount
    }

    // MARK: - Socket Accept & HTTP Parsing

    private func startAcceptLoop() {
        acceptQueue.async { [weak self] in
            guard let self else { return }
            while true {
                self.lock.lock()
                let isStopped = self.stopped
                self.lock.unlock()
                if isStopped { break }

                var clientAddr = sockaddr_in()
                var clientLen = socklen_t(MemoryLayout<sockaddr_in>.size)
                let clientFD = withUnsafeMutablePointer(to: &clientAddr) { ptr in
                    ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockPtr in
                        accept(self.listenFD, sockPtr, &clientLen)
                    }
                }
                if clientFD < 0 {
                    if errno == EINTR { continue }
                    break
                }

                #if canImport(Darwin)
                var noSigPipe: Int32 = 1
                _ = setsockopt(clientFD, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout<Int32>.size))
                #endif

                self.workerQueue.async { [weak self] in
                    self?.handleClient(clientFD)
                }
            }
        }
    }

    private func handleClient(_ fd: Int32) {
        defer { close(fd) }

        guard let parsed = readHTTPRequest(fd: fd) else {
            return
        }

        let decompressed: Data?
        if parsed.headers["content-encoding"]?.lowercased() == "gzip" {
            decompressed = try? BindGzip.decompress(parsed.body)
        } else {
            decompressed = parsed.body
        }

        let envelope: BindBatchEnvelope?
        if let jsonBytes = decompressed {
            envelope = try? JSONDecoder().decode(BindBatchEnvelope.self, from: jsonBytes)
        } else {
            envelope = nil
        }

        let provisional = FakeServerCapturedRequest(
            method: parsed.method,
            path: parsed.path,
            headers: parsed.headers,
            rawBody: parsed.body,
            decompressedBody: decompressed,
            envelope: envelope,
            receivedAt: Date(),
            statusCodeSent: 0
        )

        let response = nextResponse(for: provisional)
        let recorded = FakeServerCapturedRequest(
            method: parsed.method,
            path: parsed.path,
            headers: parsed.headers,
            rawBody: parsed.body,
            decompressedBody: decompressed,
            envelope: envelope,
            receivedAt: provisional.receivedAt,
            statusCodeSent: response.closeWithoutResponse ? 0 : response.statusCode
        )

        lock.lock()
        capturedRequests.append(recorded)
        lock.unlock()

        if response.delaySeconds > 0 {
            Thread.sleep(forTimeInterval: response.delaySeconds)
        }
        if response.closeWithoutResponse {
            return
        }

        var responseText = "HTTP/1.1 \(response.statusCode) \(response.reasonPhrase)\r\n"
        let bodyData = Data(response.body.utf8)
        responseText += "Content-Type: application/json\r\n"
        responseText += "Content-Length: \(bodyData.count)\r\n"
        responseText += "Connection: close\r\n"
        for (key, value) in response.headers {
            responseText += "\(key): \(value)\r\n"
        }
        responseText += "\r\n"

        var wire = Data(responseText.utf8)
        wire.append(bodyData)
        sendAll(fd: fd, data: wire)
    }

    private func nextResponse(for request: FakeServerCapturedRequest) -> FakeServerResponse {
        lock.lock()
        defer { lock.unlock() }
        if !scriptedResponses.isEmpty {
            return scriptedResponses.removeFirst()
        }
        if let handler = responseHandler {
            return handler(request)
        }
        return defaultResponse
    }

    private struct ParsedHTTPRequest {
        let method: String
        let path: String
        let headers: [String: String]
        let body: Data
    }

    private func readHTTPRequest(fd: Int32) -> ParsedHTTPRequest? {
        var buffer = Data()
        var chunk = [UInt8](repeating: 0, count: 16_384)
        let separator = Data("\r\n\r\n".utf8)
        var headerEndRange: Range<Data.Index>?

        while headerEndRange == nil {
            let n = recv(fd, &chunk, chunk.count, 0)
            if n <= 0 { return nil }
            buffer.append(contentsOf: chunk[0..<n])
            headerEndRange = buffer.range(of: separator)
            if buffer.count > 1_048_576 { return nil }
        }

        guard let range = headerEndRange else { return nil }
        let headerData = buffer[buffer.startIndex..<range.lowerBound]
        var bodyBuffer = Data(buffer[range.upperBound...])

        guard let headerString = String(data: headerData, encoding: .utf8) else {
            return nil
        }
        let lines = headerString.components(separatedBy: "\r\n")
        guard let requestLine = lines.first else { return nil }
        let parts = requestLine.split(separator: " ")
        guard parts.count >= 2 else { return nil }
        let method = String(parts[0])
        let path = String(parts[1])

        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            if let colon = line.firstIndex(of: ":") {
                let key = line[..<colon].trimmingCharacters(in: .whitespaces).lowercased()
                let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
                headers[key] = value
            }
        }

        let body: Data
        if let transferEncoding = headers["transfer-encoding"]?.lowercased(),
           transferEncoding.contains("chunked")
        {
            body = readChunkedBody(fd: fd, initial: bodyBuffer) ?? Data()
        } else if let contentLengthStr = headers["content-length"],
                  let contentLength = Int(contentLengthStr)
        {
            while bodyBuffer.count < contentLength {
                let n = recv(fd, &chunk, chunk.count, 0)
                if n <= 0 { break }
                bodyBuffer.append(contentsOf: chunk[0..<n])
            }
            body = Data(bodyBuffer.prefix(contentLength))
        } else {
            body = bodyBuffer
        }

        return ParsedHTTPRequest(method: method, path: path, headers: headers, body: body)
    }

    private func readChunkedBody(fd: Int32, initial: Data) -> Data? {
        var raw = initial
        var result = Data()
        var buf = [UInt8](repeating: 0, count: 16_384)
        let crlf = Data("\r\n".utf8)

        func ensure(_ minBytes: Int) -> Bool {
            while raw.count < minBytes {
                let n = recv(fd, &buf, buf.count, 0)
                if n <= 0 { return false }
                raw.append(contentsOf: buf[0..<n])
            }
            return true
        }

        while true {
            var lineRange = raw.range(of: crlf)
            while lineRange == nil {
                let n = recv(fd, &buf, buf.count, 0)
                if n <= 0 { return result }
                raw.append(contentsOf: buf[0..<n])
                lineRange = raw.range(of: crlf)
            }
            guard let range = lineRange else { return nil }
            let sizeLineData = raw[raw.startIndex..<range.lowerBound]
            raw.removeSubrange(raw.startIndex..<range.upperBound)
            guard let sizeLine = String(data: sizeLineData, encoding: .utf8) else { return nil }
            let hexPart = sizeLine.split(separator: ";").first.map(String.init)?.trimmingCharacters(in: .whitespaces) ?? ""
            guard let chunkSize = Int(hexPart, radix: 16) else { return nil }
            if chunkSize == 0 {
                return result
            }
            guard ensure(chunkSize + 2) else { return nil }
            result.append(raw.prefix(chunkSize))
            raw.removeFirst(chunkSize + 2)
        }
    }

    private func sendAll(fd: Int32, data: Data) {
        data.withUnsafeBytes { rawBuffer in
            guard let base = rawBuffer.baseAddress else { return }
            var totalSent = 0
            let total = rawBuffer.count
            while totalSent < total {
                #if canImport(Darwin)
                let flags: Int32 = 0
                #else
                let flags: Int32 = Int32(MSG_NOSIGNAL)
                #endif
                let sent = send(fd, base.advanced(by: totalSent), total - totalSent, flags)
                if sent <= 0 { break }
                totalSent += sent
            }
        }
    }
}
