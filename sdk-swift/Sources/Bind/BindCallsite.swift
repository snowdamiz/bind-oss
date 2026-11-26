/// Source-code call-site metadata captured at compile time via `#fileID`, `#line`, and `#function`.
public struct BindCallsite: Sendable, Hashable, Codable {
    public let file: String
    public let line: UInt
    public let column: UInt?
    public let function: String?

    public init(
        file: String,
        line: UInt,
        column: UInt? = nil,
        function: String? = nil
    ) {
        self.file = file
        self.line = line
        self.column = column
        self.function = function
    }
}
