import { Effect } from "effect"
import { execFile, spawn, type ChildProcess } from "node:child_process"
import { createHash } from "node:crypto"
import { createWriteStream, type WriteStream } from "node:fs"
import { mkdir, readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { finished } from "node:stream/promises"
import { promisify } from "node:util"

import type { ProcessIdentity } from "./types.js"

export interface ProcessRequest {
  readonly argv: readonly string[]
  readonly cwd: string
  readonly env?: Readonly<Record<string, string>>
  readonly stdoutPath: string
  readonly stderrPath: string
  readonly timeoutMinutes: number | null
  readonly stdin?: string
  readonly inheritEnv?: boolean
  readonly onStdoutLine?: (line: string) => void
  readonly onSpawn?: (pid: number, identity: ProcessIdentity | null) => Effect.Effect<void, Error>
}

export interface ProcessResult {
  readonly exitCode: number
  readonly signal: NodeJS.Signals | null
}

async function signalProcessTree(pid: number, force: boolean): Promise<void> {
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(pid), "/t", ...(force ? ["/f"] : [])], {
        stdio: "ignore",
        windowsHide: true
      })
      killer.once("error", () => {
        resolve()
      })
      killer.once("close", () => {
        resolve()
      })
    })
    return
  }
  process.kill(-pid, force ? "SIGKILL" : "SIGTERM")
}

interface ManagedChild {
  readonly child: ChildProcess
  readonly stdoutFile: WriteStream
  readonly stderrFile: WriteStream
  readonly completion: Promise<ProcessResult>
  readonly removeListeners: () => void
  readonly isClosed: () => boolean
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function signalExitCode(signal: NodeJS.Signals): number {
  const signals: Partial<Record<string, number>> = os.constants.signals
  return 128 + (signals[signal] ?? 0)
}

function writeChunk(
  source: NonNullable<ChildProcess["stdout"]>,
  destination: WriteStream,
  chunk: Buffer
): void {
  if (!destination.write(chunk)) {
    source.pause()
    destination.once("drain", () => source.resume())
  }
}

function spawnManagedChild(request: ProcessRequest): ManagedChild {
  const stdoutFile = createWriteStream(request.stdoutPath, { flags: "a", mode: 0o600 })
  const stderrFile = createWriteStream(request.stderrPath, { flags: "a", mode: 0o600 })
  const command = request.argv[0] as string
  const child = spawn(command, request.argv.slice(1), {
    cwd: request.cwd,
    env: request.inheritEnv === false ? { ...request.env } : { ...process.env, ...request.env },
    stdio: [request.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    detached: process.platform !== "win32"
  })
  if (request.stdin !== undefined) {
    child.stdin?.end(request.stdin)
  }
  const stdout = child.stdout
  const stderr = child.stderr
  if (stdout === null || stderr === null) {
    child.kill("SIGTERM")
    throw new Error(`Process "${command}" started without captured output streams.`)
  }

  let lineBuffer = ""
  let closed = false
  let pendingFailure: Error | null = null
  let resolveCompletion!: (result: ProcessResult) => void
  let rejectCompletion!: (error: Error) => void
  const completion = new Promise<ProcessResult>((resolve, reject) => {
    resolveCompletion = resolve
    rejectCompletion = reject
  })
  // A spawn failure can reject before any consumer chains onto this promise;
  // this no-op handler keeps that from becoming a fatal unhandled rejection.
  completion.catch(() => undefined)

  const terminate = (): void => {
    if (child.pid !== undefined) {
      void signalProcessTree(child.pid, false).catch(() => child.kill("SIGTERM"))
    }
  }
  const failAfterClose = (error: Error): void => {
    pendingFailure ??= error
    terminate()
  }
  const onStdout = (chunk: Buffer): void => {
    writeChunk(stdout, stdoutFile, chunk)
    if (request.onStdoutLine === undefined) {
      return
    }
    lineBuffer += chunk.toString("utf8")
    let newline = lineBuffer.indexOf("\n")
    while (newline !== -1) {
      request.onStdoutLine(lineBuffer.slice(0, newline))
      lineBuffer = lineBuffer.slice(newline + 1)
      newline = lineBuffer.indexOf("\n")
    }
  }
  const onStderr = (chunk: Buffer): void => {
    writeChunk(stderr, stderrFile, chunk)
  }
  const onError = (error: Error): void => {
    if (child.pid === undefined) {
      closed = true
      rejectCompletion(error)
    } else {
      failAfterClose(error)
    }
  }
  const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
    closed = true
    if (lineBuffer.length > 0) {
      request.onStdoutLine?.(lineBuffer)
      lineBuffer = ""
    }
    if (pendingFailure !== null) {
      rejectCompletion(pendingFailure)
    } else {
      resolveCompletion({
        exitCode: code ?? (signal === null ? 1 : signalExitCode(signal)),
        signal
      })
    }
  }

  stdout.on("data", onStdout)
  stderr.on("data", onStderr)
  child.on("error", onError)
  child.on("close", onClose)
  stdoutFile.on("error", failAfterClose)
  stderrFile.on("error", failAfterClose)

  return {
    child,
    stdoutFile,
    stderrFile,
    completion,
    isClosed: () => closed,
    removeListeners: () => {
      stdout.removeListener("data", onStdout)
      stderr.removeListener("data", onStderr)
      child.removeListener("close", onClose)
      stdoutFile.removeListener("error", failAfterClose)
      stderrFile.removeListener("error", failAfterClose)
      // The "error" listener stays attached for the child's lifetime: a spawn
      // failure emitted after release would otherwise crash the whole worker.
    }
  }
}

async function releaseManagedChild(
  managed: ManagedChild,
  graceMilliseconds: number
): Promise<void> {
  const { child } = managed
  if (!managed.isClosed() && child.pid !== undefined) {
    await signalProcessTree(child.pid, false).catch(() => {
      child.kill("SIGTERM")
    })
    await Promise.race([managed.completion.catch(() => undefined), wait(graceMilliseconds)])
    if (!managed.isClosed()) {
      await signalProcessTree(child.pid, true).catch(() => {
        child.kill("SIGKILL")
      })
      await managed.completion.catch(() => undefined)
    }
  }
  managed.removeListeners()
  managed.stdoutFile.end()
  managed.stderrFile.end()
  await Promise.all([
    finished(managed.stdoutFile, { cleanup: true }),
    finished(managed.stderrFile, { cleanup: true })
  ]).catch(() => undefined)
}

export interface ProcessRuntimeOptions {
  readonly terminationGraceMilliseconds?: number
}

export function runProcessEffect(
  request: ProcessRequest,
  options: ProcessRuntimeOptions = {}
): Effect.Effect<ProcessResult, Error> {
  if (request.argv.length === 0) {
    return Effect.fail(new Error("Cannot run an empty argv."))
  }
  const command = request.argv[0] as string
  return Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.tryPromise({
        try: () => mkdir(path.dirname(request.stdoutPath), { recursive: true }),
        catch: (error) => (error instanceof Error ? error : new Error(String(error)))
      })
      const managed = yield* Effect.acquireRelease(
        Effect.try({
          try: () => spawnManagedChild(request),
          catch: (error) => (error instanceof Error ? error : new Error(String(error)))
        }),
        (resource) =>
          Effect.ignore(
            Effect.tryPromise({
              try: () =>
                releaseManagedChild(resource, options.terminationGraceMilliseconds ?? 10_000),
              catch: (error) => (error instanceof Error ? error : new Error(String(error)))
            })
          )
      )
      const pid = managed.child.pid
      if (pid === undefined) {
        // A missing PID means spawn failed; the cause arrives on the deferred
        // "error" event, so surface it as an ordinary failure of this attempt.
        const missingPid = new Error(`Process "${command}" started without a PID.`)
        const failure = yield* Effect.raceFirst(
          Effect.match(
            Effect.tryPromise({
              try: () => managed.completion,
              catch: (error) => (error instanceof Error ? error : new Error(String(error)))
            }),
            { onFailure: (error) => error, onSuccess: () => missingPid }
          ),
          Effect.as(Effect.sleep(1_000), missingPid)
        )
        return yield* Effect.fail(failure)
      }
      const identity = yield* Effect.tryPromise({
        try: () => captureProcessIdentity(pid),
        catch: (error) => (error instanceof Error ? error : new Error(String(error)))
      })
      if (request.onSpawn !== undefined) {
        yield* request.onSpawn(pid, identity)
      }
      const completion = Effect.tryPromise({
        try: (signal) =>
          new Promise<ProcessResult>((resolve, reject) => {
            const interrupted = (): void => {
              reject(new Error(`Process interrupted: ${command}`))
            }
            signal.addEventListener("abort", interrupted, { once: true })
            managed.completion.then(resolve, reject).finally(() => {
              signal.removeEventListener("abort", interrupted)
            })
          }),
        catch: (error) => (error instanceof Error ? error : new Error(String(error)))
      })
      if (request.timeoutMinutes === null) {
        return yield* completion
      }
      return yield* Effect.raceFirst(
        completion,
        Effect.andThen(
          Effect.sleep(request.timeoutMinutes * 60_000),
          Effect.fail(
            new Error(`Process timed out after ${request.timeoutMinutes} minutes: ${command}`)
          )
        )
      )
    })
  )
}

const execFileAsync = promisify(execFile)

function commandDigest(command: string): string {
  return createHash("sha256").update(command).digest("hex")
}

export async function captureProcessIdentity(pid: number): Promise<ProcessIdentity | null> {
  try {
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync("powershell", [
        "-NoProfile",
        "-Command",
        `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { [pscustomobject]@{ Created=$p.CreationDate; Executable=$p.ExecutablePath; CommandLine=$p.CommandLine } | ConvertTo-Json -Compress }`
      ])
      const value = JSON.parse(stdout) as {
        readonly Created?: string
        readonly Executable?: string
        readonly CommandLine?: string
      }
      if (
        typeof value.Created !== "string" ||
        typeof value.Executable !== "string" ||
        typeof value.CommandLine !== "string"
      ) {
        return null
      }
      return {
        startedAt: value.Created,
        executable: path.resolve(value.Executable),
        commandDigest: commandDigest(value.CommandLine)
      }
    }
    const { stdout } = await execFileAsync(
      "ps",
      ["-p", String(pid), "-o", "pid=", "-o", "pgid=", "-o", "lstart=", "-o", "command="],
      { env: { ...process.env, LC_ALL: "C" } }
    )
    const match = stdout
      .trim()
      .match(
        /^(\d+)\s+(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/s
      )
    // The recorded identity is only usable for group signaling when the
    // process leads its own group, so a non-leader yields no identity.
    if (match === null || Number(match[1]) !== pid || Number(match[2]) !== pid) {
      return null
    }
    const command = match[4] ?? ""
    const executable = command.trim().split(/\s+/, 1)[0]
    if (executable === undefined || executable.length === 0) {
      return null
    }
    return {
      startedAt: match[3] as string,
      executable,
      commandDigest: commandDigest(command)
    }
  } catch {
    return null
  }
}

export async function terminateRecordedProcessTree(
  pid: number | null,
  identity: ProcessIdentity | null
): Promise<"not-running" | "terminated" | "unverified"> {
  if (pid === null) {
    return "not-running"
  }
  try {
    process.kill(pid, 0)
  } catch {
    return "not-running"
  }
  if (identity === null) {
    return "unverified"
  }
  const currentIdentity = await captureProcessIdentity(pid)
  if (
    currentIdentity === null ||
    currentIdentity.startedAt !== identity.startedAt ||
    currentIdentity.executable !== identity.executable ||
    currentIdentity.commandDigest !== identity.commandDigest
  ) {
    return "unverified"
  }
  try {
    await signalProcessTree(pid, false)
  } catch {
    try {
      process.kill(pid, 0)
    } catch {
      return "terminated"
    }
    return "unverified"
  }
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch {
      return "terminated"
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  try {
    await signalProcessTree(pid, true)
  } catch {
    // The process exited between the final liveness check and the force signal.
  }
  const forceDeadline = Date.now() + 2_000
  while (Date.now() < forceDeadline) {
    try {
      process.kill(pid, 0)
    } catch {
      return "terminated"
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return "unverified"
}

export async function readTextIfPresent(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return ""
    }
    throw error
  }
}

const STDERR_TAIL_LINES = 3
const STDERR_TAIL_MAX_CHARS = 300

// A bounded, single-line digest of a failed process's stderr — the last few
// non-empty lines, sanitized and capped — safe to embed in the node error
// message that status/report surface. The full stderr.log stays on disk.
export async function boundedStderrTail(stderrPath: string): Promise<string> {
  const lines = (await readTextIfPresent(stderrPath).catch(() => ""))
    .split("\n")
    .map((line) => line.replaceAll(/[\p{Cc}\s]+/gu, " ").trim())
    .filter((line) => line.length > 0)
    .slice(-STDERR_TAIL_LINES)
  const joined = lines.join(" | ")
  return joined.length > STDERR_TAIL_MAX_CHARS ? `…${joined.slice(-STDERR_TAIL_MAX_CHARS)}` : joined
}
