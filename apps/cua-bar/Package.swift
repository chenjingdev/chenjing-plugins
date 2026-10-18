// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "cua-bar",
    platforms: [
        .macOS(.v14),
    ],
    products: [
        .executable(name: "cua-bar", targets: ["cua_bar"]),
    ],
    dependencies: [
        // Pinned like agent-bar: only the Command Line Tools are installed here, so there is no XCTest.
        .package(
            url: "https://github.com/swiftlang/swift-testing.git",
            revision: "5ee435b15ad40ec1f644b5eb9d247f263ccd2170"
        ),
    ],
    targets: [
        .executableTarget(
            name: "cua_bar",
            path: "Sources/cua-bar"
        ),
        .testTarget(
            name: "cua_barTests",
            dependencies: [
                "cua_bar",
                .product(name: "Testing", package: "swift-testing"),
            ],
            path: "Tests/cua-barTests",
            resources: [.copy("Fixtures")]
        ),
    ]
)
