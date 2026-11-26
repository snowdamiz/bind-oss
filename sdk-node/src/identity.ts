import type { BatchIdentity } from "./types.js";

export const DEFAULT_ENDPOINT = "https://ingest.bind.dev";
export const BATCH_PATH = "/v1/batch";

function firstNonEmpty(...values: ReadonlyArray<string | undefined>): string | undefined {
  for (const value of values) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
    }
  }
  return undefined;
}

export function getDefaultEnvSource(): Record<string, string | undefined> {
  if (typeof process !== "undefined" && process.env) {
    return process.env;
  }
  return {};
}

export interface IdentityInput {
  service?: string;
  env?: string;
  release?: string;
  envSource?: Record<string, string | undefined>;
}

/**
 * Resolves frozen batch identity (`service`, `env`, `release`) from explicit
 * options with standard environment fallbacks.
 */
export function resolveIdentity(input: IdentityInput = {}): Readonly<BatchIdentity> {
  const envMap = input.envSource ?? getDefaultEnvSource();

  const service =
    firstNonEmpty(
      input.service,
      envMap.BIND_SERVICE,
      envMap.OTEL_SERVICE_NAME,
      envMap.npm_package_name,
    ) ?? "unknown-service";

  const env =
    firstNonEmpty(input.env, envMap.BIND_ENV, envMap.NODE_ENV) ?? "development";

  const release =
    firstNonEmpty(
      input.release,
      envMap.BIND_RELEASE,
      envMap.GIT_SHA,
      envMap.GITHUB_SHA,
      envMap.VERCEL_GIT_COMMIT_SHA,
      envMap.npm_package_version,
    ) ?? "unknown";

  return Object.freeze({ service, env, release });
}

/**
 * Pre-serializes the immutable envelope identity fields once so every batch
 * reuses the exact queued identity payload fragment without re-encoding.
 */
export function buildIdentityPayloadFragment(identity: Readonly<BatchIdentity>): string {
  return `,"service":${JSON.stringify(identity.service)},"env":${JSON.stringify(identity.env)},"release":${JSON.stringify(identity.release)}`;
}

/**
 * Resolves a base ingest URL or full batch endpoint URL into the exact
 * `POST /v1/batch` target URL.
 */
export function resolveBatchUrl(endpoint?: string): string {
  const raw = firstNonEmpty(endpoint) ?? DEFAULT_ENDPOINT;
  const parsed = new URL(raw);
  const trimmedPath = parsed.pathname.replace(/\/+$/, "");
  if (trimmedPath.endsWith(BATCH_PATH)) {
    parsed.pathname = trimmedPath;
  } else {
    parsed.pathname = `${trimmedPath}${BATCH_PATH}`;
  }
  return parsed.toString();
}
