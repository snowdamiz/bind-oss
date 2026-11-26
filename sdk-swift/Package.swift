// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "Bind",
    platforms: [
        .iOS(.v15),
        .macOS(.v12),
    ],
    products: [
        .library(
            name: "Bind",
            targets: ["Bind"]
        ),
    ],
    dependencies: [],
    targets: [
        .target(
            name: "Bind",
            dependencies: []
        ),
        .testTarget(
            name: "BindTests",
            dependencies: ["Bind"]
        ),
    ]
)
