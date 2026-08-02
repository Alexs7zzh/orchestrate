#!/usr/bin/env node

import { runCli } from "./cli.js"

const scriptPath = process.argv[1] ?? new URL(import.meta.url).pathname

try {
  process.exitCode = await runCli(process.argv.slice(2), scriptPath)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
