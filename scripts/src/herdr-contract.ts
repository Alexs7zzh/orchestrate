export const MINIMUM_HERDR_VERSION = [0, 7, 5] as const
export const HERDR_SCHEMA_BASELINE_VERSION = MINIMUM_HERDR_VERSION.join(".")

export type RunHerdrSchemaCommand = (args: readonly string[]) => Promise<string>

function reportedHerdrVersion(output: string): string | null {
  return output.match(/(?:^|\s)(\d+\.\d+\.\d+)(?:\s|$)/)?.[1] ?? null
}

export async function fetchBaselineHerdrApiSchema(run: RunHerdrSchemaCommand): Promise<unknown> {
  const versionOutput = (await run(["--version"])).trim()
  const version = reportedHerdrVersion(versionOutput)
  if (version !== HERDR_SCHEMA_BASELINE_VERSION) {
    throw new Error(
      `Herdr schema refresh requires exactly ${HERDR_SCHEMA_BASELINE_VERSION}; found "${versionOutput}".`
    )
  }
  return JSON.parse(await run(["api", "schema", "--json"])) as unknown
}
