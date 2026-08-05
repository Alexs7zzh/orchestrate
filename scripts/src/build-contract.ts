export const SOURCE_BUNDLE_TARGET = "node" as const
export const COMPILED_BUNDLE_TARGET = "bun" as const
export const TARGET_PLATFORM = "darwin" as const
export const TARGET_ARCHITECTURE = "arm64" as const
export const COMPILED_TARGET =
  `bun-${TARGET_PLATFORM}-${TARGET_ARCHITECTURE}` satisfies Bun.Build.CompileTarget
export const MINIMUM_MACOS_VERSION = "13.0"

export interface BuildToolchainIdentity {
  readonly artifact: "bundle" | "compiled"
  readonly bunVersion: string
  readonly bunRevision: string
  readonly target: string
  readonly minimumMacOSVersion: string | null
}

export function buildToolchainIdentity(value: BuildToolchainIdentity): string {
  return [
    `artifact:${value.artifact}`,
    `bun-version:${value.bunVersion}`,
    `bun-revision:${value.bunRevision}`,
    `target:${value.target}`,
    `minimum-macos:${value.minimumMacOSVersion ?? "none"}`
  ].join("\n")
}
