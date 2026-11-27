# bind-oss

Open-source SDKs, declarative parser specification, parser runtimes, CLI, and examples for Bind.

> **Status:** Initial repository scaffold. Packages and conformance artifacts are under active development.

## Repository layout

| Directory | Contents |
| --- | --- |
| [`sdk-node/`](sdk-node/) | Node.js, Bun, and Deno TypeScript SDK (`@bind/node`) with zero runtime dependencies and ESM/CJS builds. |
| [`sdk-swift/`](sdk-swift/) | Swift source package (`Bind`) for iOS 15+, macOS 12+, and Linux, including the `swift-log` backend, `#log` macro product, and Swift parser runtime for edge mode. |
| [`cli/`](cli/) | Command-line tool (`@bind/cli`) for managing, testing, and verifying parser specs, reusing `runtime-ts/`. |
| [`spec/`](spec/) | Declarative parser specification JSON Schema, event type schema, golden conformance vectors, and differential test tooling. |
| [`runtime-ts/`](runtime-ts/) | Hand-written TypeScript segment-scanner parser runtime shared by `@bind/node` edge mode and `@bind/cli`. |
| [`examples/`](examples/) | Runnable Node.js and Swift example applications. |

## License

Licensed under the [Apache License, Version 2.0](LICENSE).
