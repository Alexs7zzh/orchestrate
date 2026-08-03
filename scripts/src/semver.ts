const CORE_IDENTIFIER = "(?:0|[1-9]\\d*)"
const PRERELEASE_IDENTIFIER = "(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)"
const BUILD_IDENTIFIER = "[0-9A-Za-z-]+"

export const SEMVER_PATTERN = new RegExp(
  `^${CORE_IDENTIFIER}\\.${CORE_IDENTIFIER}\\.${CORE_IDENTIFIER}` +
    `(?:-(${PRERELEASE_IDENTIFIER}(?:\\.${PRERELEASE_IDENTIFIER})*))?` +
    `(?:\\+(${BUILD_IDENTIFIER}(?:\\.${BUILD_IDENTIFIER})*))?$`
)

export interface ParsedSemVer {
  readonly version: string
  readonly buildMetadata: string | null
}

export function parseSemVer(value: string): ParsedSemVer | null {
  const match = SEMVER_PATTERN.exec(value)
  return match === null ? null : { version: value, buildMetadata: match[2] ?? null }
}

export function assertReleaseVersion(value: string): string {
  const parsed = parseSemVer(value)
  if (parsed === null) {
    throw new Error(`Invalid SemVer 2.0 release version "${value}".`)
  }
  if (parsed.buildMetadata !== null) {
    throw new Error(
      `Release version "${value}" must not contain build metadata; orchestrate appends its compiled build identity.`
    )
  }
  return parsed.version
}
