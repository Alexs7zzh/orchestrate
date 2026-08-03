#!/usr/bin/env node

import { jsonError, jsonRequested, runCli } from "./cli.js"

const scriptPath = process.argv[1] ?? new URL(import.meta.url).pathname

try {
  process.exitCode = await runCli(process.argv.slice(2), scriptPath)
} catch (error) {
  if (jsonRequested(process.argv.slice(2))) {
    console.log(JSON.stringify(jsonError(error)))
  } else {
    console.error(error instanceof Error ? error.message : String(error))
  }
  process.exitCode = 1
}
