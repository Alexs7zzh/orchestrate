import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { access, chmod, mkdir, open, realpath, stat } from "node:fs/promises"
import path from "node:path"

import type { AgentNode, WorkflowSpec } from "./types.js"

import { atomicWriteFile } from "./state.js"

const SHEBANG_LIMIT_BYTES = 4_096
const MAX_INTERPRETER_DEPTH = 16
const MAX_EXECUTABLE_BYTES = 512 * 1024 * 1024
const ENV_PATH = "/usr/bin/env"
const RELAY_INTERPRETER_PATH = "/bin/sh"

export interface CanonicalFileIdentity {
  readonly lexicalPath: string
  readonly canonicalPath: string
  readonly device: string
  readonly inode: string
  readonly mode: number
  readonly byteLength: number
  readonly sha256: string
}

export interface CanonicalDirectoryIdentity {
  readonly lexicalPath: string
  readonly canonicalPath: string
  readonly exists: boolean
  readonly device: string | null
  readonly inode: string | null
  readonly mode: number | null
}

export interface PathLookupIdentity {
  readonly command: string
  readonly searchedDirectories: readonly CanonicalDirectoryIdentity[]
  readonly candidatePath: string
  readonly executable: CanonicalFileIdentity
}

export interface ProviderShebangHop {
  readonly script: CanonicalFileIdentity
  readonly declaredInterpreter: CanonicalFileIdentity
  readonly kind: "absolute" | "env" | "env-split"
  readonly fixedArguments: readonly string[]
  readonly lookup: PathLookupIdentity | null
}

export interface ProviderLaunchAuthorityEntry {
  readonly label: string
  readonly path: string
}

export interface ProviderLaunchIdentity {
  readonly provider: AgentNode["provider"]
  readonly normalizedPath: string
  readonly pathDirectories: readonly CanonicalDirectoryIdentity[]
  readonly entryLookup: PathLookupIdentity
  readonly entry: CanonicalFileIdentity
  readonly shebangChain: readonly ProviderShebangHop[]
  readonly terminalExecutable: CanonicalFileIdentity
  /** Exact arguments between the terminal executable and Herdr's provider arguments. */
  readonly fixedArguments: readonly string[]
  /** Exact fixed execution argv. Herdr's provider arguments are appended unchanged. */
  readonly executionArgv: readonly string[]
  readonly relayInterpreter: CanonicalFileIdentity
  readonly authorityEntries: readonly ProviderLaunchAuthorityEntry[]
}

export interface MaterializedProviderRelay {
  readonly directory: CanonicalDirectoryIdentity
  readonly path: string
  readonly identity: CanonicalFileIdentity
  readonly sha256: string
  readonly environmentPath: string
}

export interface CompiledProviderPath {
  readonly normalizedPath: string
  readonly directories: readonly CanonicalDirectoryIdentity[]
}

function exactObject(
  value: unknown,
  keys: readonly string[],
  label: string
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`)
  }
  const record = value as Record<string, unknown>
  const actual = Object.keys(record).toSorted()
  const expected = [...keys].toSorted()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has missing or excess fields.`)
  }
  return record
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new Error(`${label} must be a nonempty string without NUL bytes.`)
  }
  return value
}

function requiredAbsolutePath(value: unknown, label: string): string {
  const decoded = requiredString(value, label)
  if (!path.isAbsolute(decoded) || path.normalize(decoded) !== decoded) {
    throw new Error(`${label} must be a normalized absolute path.`)
  }
  return decoded
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array.`)
  }
  return value.map((entry, index) => requiredString(entry, `${label}[${index}]`))
}

function decodeFileIdentity(value: unknown, label: string): CanonicalFileIdentity {
  const record = exactObject(
    value,
    ["lexicalPath", "canonicalPath", "device", "inode", "mode", "byteLength", "sha256"],
    label
  )
  const mode = record.mode
  const byteLength = record.byteLength
  const sha256 = record.sha256
  if (!Number.isInteger(mode) || (mode as number) < 0 || (mode as number) > 0o7777) {
    throw new Error(`${label}.mode is invalid.`)
  }
  if (!Number.isSafeInteger(byteLength) || (byteLength as number) < 0) {
    throw new Error(`${label}.byteLength is invalid.`)
  }
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error(`${label}.sha256 is invalid.`)
  }
  return {
    lexicalPath: requiredAbsolutePath(record.lexicalPath, `${label}.lexicalPath`),
    canonicalPath: requiredAbsolutePath(record.canonicalPath, `${label}.canonicalPath`),
    device: requiredString(record.device, `${label}.device`),
    inode: requiredString(record.inode, `${label}.inode`),
    mode: mode as number,
    byteLength: byteLength as number,
    sha256
  }
}

function decodeDirectoryIdentity(value: unknown, label: string): CanonicalDirectoryIdentity {
  const record = exactObject(
    value,
    ["lexicalPath", "canonicalPath", "exists", "device", "inode", "mode"],
    label
  )
  if (typeof record.exists !== "boolean") {
    throw new TypeError(`${label}.exists must be boolean.`)
  }
  const nullableString = (candidate: unknown, field: string): string | null => {
    if (candidate === null) {
      return null
    }
    return requiredString(candidate, `${label}.${field}`)
  }
  const mode = record.mode
  if (
    mode !== null &&
    (!Number.isInteger(mode) || (mode as number) < 0 || (mode as number) > 0o7777)
  ) {
    throw new Error(`${label}.mode is invalid.`)
  }
  const decoded = {
    lexicalPath: requiredAbsolutePath(record.lexicalPath, `${label}.lexicalPath`),
    canonicalPath: requiredAbsolutePath(record.canonicalPath, `${label}.canonicalPath`),
    exists: record.exists,
    device: nullableString(record.device, "device"),
    inode: nullableString(record.inode, "inode"),
    mode: mode as number | null
  }
  if (
    decoded.exists !== (decoded.device !== null && decoded.inode !== null && decoded.mode !== null)
  ) {
    throw new Error(`${label} existence fields are inconsistent.`)
  }
  return decoded
}

function decodeLookup(value: unknown, label: string): PathLookupIdentity {
  const record = exactObject(
    value,
    ["command", "searchedDirectories", "candidatePath", "executable"],
    label
  )
  if (!Array.isArray(record.searchedDirectories) || record.searchedDirectories.length === 0) {
    throw new Error(`${label}.searchedDirectories must be a nonempty array.`)
  }
  return {
    command: requiredString(record.command, `${label}.command`),
    searchedDirectories: record.searchedDirectories.map((entry, index) =>
      decodeDirectoryIdentity(entry, `${label}.searchedDirectories[${index}]`)
    ),
    candidatePath: requiredAbsolutePath(record.candidatePath, `${label}.candidatePath`),
    executable: decodeFileIdentity(record.executable, `${label}.executable`)
  }
}

function decodeShebangHop(value: unknown, label: string): ProviderShebangHop {
  const record = exactObject(
    value,
    ["script", "declaredInterpreter", "kind", "fixedArguments", "lookup"],
    label
  )
  if (!(["absolute", "env", "env-split"] as const).includes(record.kind as never)) {
    throw new Error(`${label}.kind is invalid.`)
  }
  const lookup = record.lookup === null ? null : decodeLookup(record.lookup, `${label}.lookup`)
  if ((record.kind === "absolute") !== (lookup === null)) {
    throw new Error(`${label} lookup is inconsistent with its kind.`)
  }
  return {
    script: decodeFileIdentity(record.script, `${label}.script`),
    declaredInterpreter: decodeFileIdentity(
      record.declaredInterpreter,
      `${label}.declaredInterpreter`
    ),
    kind: record.kind as ProviderShebangHop["kind"],
    fixedArguments: stringArray(record.fixedArguments, `${label}.fixedArguments`),
    lookup
  }
}

export function decodeProviderLaunchIdentity(value: unknown): ProviderLaunchIdentity {
  const record = exactObject(
    value,
    [
      "provider",
      "normalizedPath",
      "pathDirectories",
      "entryLookup",
      "entry",
      "shebangChain",
      "terminalExecutable",
      "fixedArguments",
      "executionArgv",
      "relayInterpreter",
      "authorityEntries"
    ],
    "ProviderLaunchIdentity"
  )
  if (record.provider !== "codex" && record.provider !== "claude") {
    throw new Error("ProviderLaunchIdentity.provider is invalid.")
  }
  if (!Array.isArray(record.pathDirectories) || record.pathDirectories.length === 0) {
    throw new Error("ProviderLaunchIdentity.pathDirectories must be nonempty.")
  }
  if (!Array.isArray(record.shebangChain) || !Array.isArray(record.authorityEntries)) {
    throw new TypeError("ProviderLaunchIdentity nested lists are invalid.")
  }
  const fixedArguments = stringArray(record.fixedArguments, "ProviderLaunchIdentity.fixedArguments")
  const executionArgv = stringArray(record.executionArgv, "ProviderLaunchIdentity.executionArgv")
  const terminalExecutable = decodeFileIdentity(
    record.terminalExecutable,
    "ProviderLaunchIdentity.terminalExecutable"
  )
  if (
    executionArgv.length !== fixedArguments.length + 1 ||
    executionArgv[0] !== terminalExecutable.canonicalPath ||
    fixedArguments.some((argument, index) => executionArgv[index + 1] !== argument)
  ) {
    throw new Error("ProviderLaunchIdentity.executionArgv is inconsistent with its fixed argv.")
  }
  const decodedAuthorityEntries = record.authorityEntries.map((entry, index) => {
    const decoded = exactObject(entry, ["label", "path"], `authorityEntries[${index}]`)
    return {
      label: requiredString(decoded.label, `authorityEntries[${index}].label`),
      path: requiredAbsolutePath(decoded.path, `authorityEntries[${index}].path`)
    }
  })
  const decoded: ProviderLaunchIdentity = {
    provider: record.provider,
    normalizedPath: requiredString(record.normalizedPath, "ProviderLaunchIdentity.normalizedPath"),
    pathDirectories: record.pathDirectories.map((entry, index) =>
      decodeDirectoryIdentity(entry, `ProviderLaunchIdentity.pathDirectories[${index}]`)
    ),
    entryLookup: decodeLookup(record.entryLookup, "ProviderLaunchIdentity.entryLookup"),
    entry: decodeFileIdentity(record.entry, "ProviderLaunchIdentity.entry"),
    shebangChain: record.shebangChain.map((entry, index) =>
      decodeShebangHop(entry, `ProviderLaunchIdentity.shebangChain[${index}]`)
    ),
    terminalExecutable,
    fixedArguments,
    executionArgv,
    relayInterpreter: decodeFileIdentity(
      record.relayInterpreter,
      "ProviderLaunchIdentity.relayInterpreter"
    ),
    authorityEntries: decodedAuthorityEntries
  }
  if (JSON.stringify(decoded.entry) !== JSON.stringify(decoded.entryLookup.executable)) {
    throw new Error("ProviderLaunchIdentity.entry does not match entryLookup.executable.")
  }
  if (
    decoded.normalizedPath !==
    decoded.pathDirectories.map((entry) => entry.lexicalPath).join(path.delimiter)
  ) {
    throw new Error(
      "ProviderLaunchIdentity.normalizedPath does not match its directory identities."
    )
  }
  return decoded
}

export function assertProviderLaunchIdentity(
  value: unknown
): asserts value is ProviderLaunchIdentity {
  decodeProviderLaunchIdentity(value)
}

export function decodeMaterializedProviderRelay(value: unknown): MaterializedProviderRelay {
  const record = exactObject(
    value,
    ["directory", "path", "identity", "sha256", "environmentPath"],
    "MaterializedProviderRelay"
  )
  if (typeof record.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(record.sha256)) {
    throw new Error("MaterializedProviderRelay.sha256 is invalid.")
  }
  const decoded = {
    directory: decodeDirectoryIdentity(record.directory, "MaterializedProviderRelay.directory"),
    path: requiredAbsolutePath(record.path, "MaterializedProviderRelay.path"),
    identity: decodeFileIdentity(record.identity, "MaterializedProviderRelay.identity"),
    sha256: record.sha256,
    environmentPath: requiredString(
      record.environmentPath,
      "MaterializedProviderRelay.environmentPath"
    )
  }
  if (
    decoded.path !== decoded.identity.lexicalPath ||
    decoded.sha256 !== decoded.identity.sha256 ||
    decoded.environmentPath.split(path.delimiter)[0] !== decoded.directory.canonicalPath
  ) {
    throw new Error("MaterializedProviderRelay fields have an invalid identity binding.")
  }
  return decoded
}

function modeBits(mode: bigint): number {
  return Number(mode & 0o7777n)
}

async function existingFileIdentity(candidate: string): Promise<CanonicalFileIdentity> {
  const lexicalPath = path.normalize(candidate)
  const canonicalPath = await realpath(lexicalPath)
  const handle = await open(
    canonicalPath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  )
  try {
    const info = await handle.stat({ bigint: true })
    if (!info.isFile()) {
      throw new Error(`Provider launch executable "${lexicalPath}" is not a regular file.`)
    }
    if (info.size > BigInt(MAX_EXECUTABLE_BYTES)) {
      throw new Error(
        `Provider launch executable "${lexicalPath}" exceeds ${MAX_EXECUTABLE_BYTES} bytes.`
      )
    }
    await access(canonicalPath, constants.X_OK)
    const digest = createHash("sha256")
    const buffer = Buffer.alloc(64 * 1024)
    let offset = 0
    while (offset < Number(info.size)) {
      const length = Math.min(buffer.byteLength, Number(info.size) - offset)
      const { bytesRead } = await handle.read(buffer, 0, length, offset)
      if (bytesRead === 0) {
        throw new Error(`Provider launch executable "${lexicalPath}" changed while hashing.`)
      }
      digest.update(buffer.subarray(0, bytesRead))
      offset += bytesRead
    }
    const after = await handle.stat({ bigint: true })
    if (
      after.dev !== info.dev ||
      after.ino !== info.ino ||
      after.mode !== info.mode ||
      after.size !== info.size ||
      after.mtimeNs !== info.mtimeNs ||
      after.ctimeNs !== info.ctimeNs
    ) {
      throw new Error(`Provider launch executable "${lexicalPath}" changed while hashing.`)
    }
    return {
      lexicalPath,
      canonicalPath,
      device: String(info.dev),
      inode: String(info.ino),
      mode: modeBits(info.mode),
      byteLength: Number(info.size),
      sha256: digest.digest("hex")
    }
  } finally {
    await handle.close()
  }
}

async function resolveMissingPath(candidate: string): Promise<string> {
  const suffix: string[] = []
  let cursor = candidate
  for (;;) {
    try {
      const ancestor = await realpath(cursor)
      return path.join(ancestor, ...suffix.toReversed())
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error
      }
      const parent = path.dirname(cursor)
      if (parent === cursor) {
        throw error
      }
      suffix.push(path.basename(cursor))
      cursor = parent
    }
  }
}

async function directoryIdentity(candidate: string): Promise<CanonicalDirectoryIdentity> {
  const lexicalPath = path.normalize(candidate)
  try {
    const canonicalPath = await realpath(lexicalPath)
    const info = await stat(canonicalPath, { bigint: true })
    if (!info.isDirectory()) {
      throw new Error(`Provider PATH entry "${lexicalPath}" is not a directory.`)
    }
    return {
      lexicalPath,
      canonicalPath,
      exists: true,
      device: String(info.dev),
      inode: String(info.ino),
      mode: modeBits(info.mode)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error
    }
    return {
      lexicalPath,
      canonicalPath: await resolveMissingPath(lexicalPath),
      exists: false,
      device: null,
      inode: null,
      mode: null
    }
  }
}

export async function compileProviderPath(
  rawPath = process.env.PATH ?? ""
): Promise<CompiledProviderPath> {
  const entries = rawPath.split(path.delimiter)
  if (entries.length === 0 || entries.some((entry) => entry.length === 0)) {
    throw new Error(
      "Launcher PATH contains an empty component; provider lookup requires absolute entries."
    )
  }
  for (const entry of entries) {
    if (!path.isAbsolute(entry)) {
      throw new Error(
        `Launcher PATH component ${JSON.stringify(entry)} is relative; provider lookup requires absolute entries.`
      )
    }
  }
  const normalized = entries.map((entry) => path.normalize(entry))
  const inspected = await Promise.all(normalized.map(directoryIdentity))
  // Canonical aliases after their first occurrence cannot affect precedence.
  // Omit them so the frozen environment and authority snapshot are injective.
  const directories = inspected.filter(
    (directory, index) =>
      inspected.findIndex((candidate) => candidate.canonicalPath === directory.canonicalPath) ===
      index
  )
  return {
    normalizedPath: directories.map((directory) => directory.lexicalPath).join(path.delimiter),
    directories
  }
}

async function lookupExecutable(
  command: string,
  directories: readonly CanonicalDirectoryIdentity[]
): Promise<PathLookupIdentity> {
  if (
    command.length === 0 ||
    command.includes("/") ||
    command.includes("\0") ||
    command === "." ||
    command === ".."
  ) {
    throw new Error(`Provider PATH lookup command ${JSON.stringify(command)} is malformed.`)
  }
  const searched: CanonicalDirectoryIdentity[] = []
  for (const directory of directories) {
    searched.push(directory)
    if (!directory.exists) {
      continue
    }
    const candidatePath = path.join(directory.lexicalPath, command)
    try {
      const candidate = await stat(candidatePath)
      if (!candidate.isFile()) {
        continue
      }
      const executable = await existingFileIdentity(candidatePath)
      return { command, searchedDirectories: searched, candidatePath, executable }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === "ENOENT") {
        continue
      }
      throw error
    }
  }
  throw new Error(`Provider executable "${command}" is not on the launcher-owned PATH.`)
}

async function readShebang(identity: CanonicalFileIdentity): Promise<string | null> {
  const handle = await open(
    identity.canonicalPath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  )
  try {
    const prefix = Buffer.alloc(SHEBANG_LIMIT_BYTES + 1)
    const { bytesRead } = await handle.read(prefix, 0, prefix.byteLength, 0)
    if (bytesRead < 2 || prefix[0] !== 0x23 || prefix[1] !== 0x21) {
      return null
    }
    const newline = prefix.subarray(0, bytesRead).indexOf(0x0a)
    if (newline < 0 && bytesRead > SHEBANG_LIMIT_BYTES) {
      throw new Error(
        `Provider shebang in "${identity.canonicalPath}" exceeds the supported limit.`
      )
    }
    const end = newline < 0 ? bytesRead : newline
    const bytes = prefix.subarray(2, end)
    let line: string
    try {
      line = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    } catch (error) {
      throw new Error(`Provider shebang in "${identity.canonicalPath}" is not valid UTF-8.`, {
        cause: error
      })
    }
    if (line.endsWith("\r")) {
      line = line.slice(0, -1)
    }
    if (/\p{Cc}/u.test(line)) {
      throw new Error(`Provider shebang in "${identity.canonicalPath}" contains control bytes.`)
    }
    const trimmed = line.trim()
    if (trimmed.length === 0) {
      throw new Error(`Provider shebang in "${identity.canonicalPath}" has no interpreter.`)
    }
    return trimmed
  } finally {
    await handle.close()
  }
}

function splitInterpreter(line: string): {
  readonly interpreter: string
  readonly argument: string | null
} {
  const separator = line.search(/[ \t]/)
  if (separator < 0) {
    return { interpreter: line, argument: null }
  }
  const interpreter = line.slice(0, separator)
  const argument = line.slice(separator).trim()
  if (argument.length === 0) {
    return { interpreter, argument: null }
  }
  return { interpreter, argument }
}

function splitEnvWords(value: string): readonly string[] {
  // Deliberately support the deterministic, portable subset of env -S. The
  // platform env implementations disagree on expansion and escape details;
  // launch authority must never depend on those ambient parsing rules.
  if (value.length === 0 || /[\\'"`$\r\n]/.test(value)) {
    throw new Error(`Unsupported or malformed /usr/bin/env -S string ${JSON.stringify(value)}.`)
  }
  const words = value.trim().split(/[ \t]+/)
  if (words.some((word) => word.length === 0)) {
    throw new Error(`Malformed /usr/bin/env -S string ${JSON.stringify(value)}.`)
  }
  return words
}

interface CompiledChain {
  readonly hops: readonly ProviderShebangHop[]
  readonly terminal: CanonicalFileIdentity
  readonly fixedArguments: readonly string[]
}

async function compileInterpreterChain(
  script: CanonicalFileIdentity,
  directories: readonly CanonicalDirectoryIdentity[],
  active: ReadonlySet<string>,
  depth: number
): Promise<CompiledChain> {
  if (depth > MAX_INTERPRETER_DEPTH) {
    throw new Error(`Provider interpreter chain exceeds ${MAX_INTERPRETER_DEPTH} hops.`)
  }
  const key = `${script.device}:${script.inode}`
  if (active.has(key)) {
    throw new Error(`Provider interpreter chain is recursive at "${script.canonicalPath}".`)
  }
  const nextActive = new Set(active)
  nextActive.add(key)
  const shebang = await readShebang(script)
  if (shebang === null) {
    return { hops: [], terminal: script, fixedArguments: [] }
  }
  const parsed = splitInterpreter(shebang)
  if (!path.isAbsolute(parsed.interpreter)) {
    throw new Error(
      `Provider shebang interpreter ${JSON.stringify(parsed.interpreter)} in "${script.canonicalPath}" is not absolute.`
    )
  }

  let declaredInterpreter: CanonicalFileIdentity
  let interpreter: CanonicalFileIdentity
  let kind: ProviderShebangHop["kind"] = "absolute"
  let fixedArguments: readonly string[]
  let lookup: PathLookupIdentity | null = null
  if (parsed.interpreter === ENV_PATH) {
    declaredInterpreter = await existingFileIdentity(ENV_PATH)
    if (parsed.argument === null) {
      throw new Error(`/usr/bin/env shebang in "${script.canonicalPath}" has no command.`)
    }
    const words = parsed.argument.startsWith("-S ")
      ? splitEnvWords(parsed.argument.slice(3))
      : parsed.argument.startsWith("-") || /[ \t]/.test(parsed.argument)
        ? null
        : [parsed.argument]
    if (words === null || words.length === 0) {
      throw new Error(
        `Unsupported /usr/bin/env shebang arguments ${JSON.stringify(parsed.argument)} in "${script.canonicalPath}".`
      )
    }
    if ((words[0] as string).startsWith("-") || (words[0] as string).includes("=")) {
      throw new Error(
        `Unsupported /usr/bin/env command ${JSON.stringify(words[0])} in "${script.canonicalPath}".`
      )
    }
    lookup = await lookupExecutable(words[0] as string, directories)
    interpreter = lookup.executable
    fixedArguments = words.slice(1)
    kind = parsed.argument.startsWith("-S ") ? "env-split" : "env"
  } else {
    declaredInterpreter = await existingFileIdentity(parsed.interpreter)
    if (declaredInterpreter.canonicalPath === (await realpath(ENV_PATH))) {
      throw new Error(
        `Provider shebang in "${script.canonicalPath}" must spell /usr/bin/env exactly.`
      )
    }
    interpreter = declaredInterpreter
    fixedArguments = parsed.argument === null ? [] : [parsed.argument]
  }
  const nested = await compileInterpreterChain(interpreter, directories, nextActive, depth + 1)
  return {
    hops: [
      {
        script,
        declaredInterpreter,
        kind,
        fixedArguments,
        lookup
      },
      ...nested.hops
    ],
    terminal: nested.terminal,
    fixedArguments: [...nested.fixedArguments, ...fixedArguments, script.canonicalPath]
  }
}

function authorityEntries(
  entryLookup: PathLookupIdentity,
  chain: CompiledChain,
  relayInterpreter: CanonicalFileIdentity
): readonly ProviderLaunchAuthorityEntry[] {
  const entries: ProviderLaunchAuthorityEntry[] = []
  const addLookup = (label: string, lookup: PathLookupIdentity): void => {
    for (const [index, directory] of lookup.searchedDirectories.entries()) {
      entries.push({
        label: `${label} PATH precedence[${index}]`,
        path: directory.canonicalPath
      })
    }
    entries.push({ label: `${label} executable`, path: lookup.executable.canonicalPath })
  }
  addLookup(`provider ${entryLookup.command}`, entryLookup)
  for (const [index, hop] of chain.hops.entries()) {
    entries.push({
      label: `provider interpreter[${index}]`,
      path: hop.declaredInterpreter.canonicalPath
    })
    if (hop.lookup !== null) {
      addLookup(`provider interpreter[${index}] ${hop.lookup.command}`, hop.lookup)
    }
  }
  entries.push({ label: "provider terminal executable", path: chain.terminal.canonicalPath })
  entries.push({ label: "provider relay interpreter", path: relayInterpreter.canonicalPath })
  return entries.filter(
    (entry, index) =>
      entries.findIndex(
        (candidate) => candidate.label === entry.label && candidate.path === entry.path
      ) === index
  )
}

export async function compileProviderLaunchIdentity(
  provider: AgentNode["provider"],
  rawPath = process.env.PATH ?? ""
): Promise<ProviderLaunchIdentity> {
  const compiledPath = await compileProviderPath(rawPath)
  return compileProviderLaunchIdentityFromPath(provider, compiledPath)
}

export async function compileProviderLaunchIdentityFromPath(
  provider: AgentNode["provider"],
  compiledPath: CompiledProviderPath
): Promise<ProviderLaunchIdentity> {
  const entryLookup = await lookupExecutable(provider, compiledPath.directories)
  const chain = await compileInterpreterChain(
    entryLookup.executable,
    compiledPath.directories,
    new Set(),
    0
  )
  const relayInterpreter = await existingFileIdentity(RELAY_INTERPRETER_PATH)
  if ((await readShebang(relayInterpreter)) !== null) {
    throw new Error(
      `Provider relay interpreter "${relayInterpreter.canonicalPath}" must be native.`
    )
  }
  const identity: ProviderLaunchIdentity = {
    provider,
    normalizedPath: compiledPath.normalizedPath,
    pathDirectories: compiledPath.directories,
    entryLookup,
    entry: entryLookup.executable,
    shebangChain: chain.hops,
    terminalExecutable: chain.terminal,
    fixedArguments: chain.fixedArguments,
    executionArgv: [chain.terminal.canonicalPath, ...chain.fixedArguments],
    relayInterpreter,
    authorityEntries: authorityEntries(entryLookup, chain, relayInterpreter)
  }
  await revalidateProviderLaunchIdentity(identity)
  return identity
}

export async function compileWorkflowProviderLaunchIdentities(
  workflow: WorkflowSpec,
  rawPath = process.env.PATH ?? ""
): Promise<readonly ProviderLaunchIdentity[]> {
  const providers = new Set(
    workflow.nodes.flatMap((node) => (node.type === "agent" ? [node.provider] : []))
  )
  const identities: ProviderLaunchIdentity[] = []
  const compiledPath = await compileProviderPath(rawPath)
  for (const provider of providers) {
    identities.push(await compileProviderLaunchIdentityFromPath(provider, compiledPath))
  }
  return identities
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

export async function materializeProviderRelay(
  identity: ProviderLaunchIdentity,
  controlDirectory: string
): Promise<MaterializedProviderRelay> {
  if (!path.isAbsolute(controlDirectory)) {
    throw new Error("Provider relay control directory must be absolute.")
  }
  await mkdir(controlDirectory, { recursive: true, mode: 0o700 })
  await chmod(controlDirectory, 0o700)
  const directory = await directoryIdentity(controlDirectory)
  if (!directory.exists) {
    throw new Error(`Provider relay control directory "${controlDirectory}" was not created.`)
  }
  const relayPath = path.join(directory.canonicalPath, identity.provider)
  const content = [
    `#!${identity.relayInterpreter.lexicalPath}`,
    `exec ${identity.executionArgv.map(shellQuote).join(" ")} "$@"`,
    ""
  ].join("\n")
  await atomicWriteFile(relayPath, content, 0o500)
  const relayIdentity = await existingFileIdentity(relayPath)
  const sha256 = createHash("sha256").update(content).digest("hex")
  if (relayIdentity.sha256 !== sha256) {
    throw new Error(`Provider relay "${relayPath}" changed during materialization.`)
  }
  return {
    directory,
    path: relayPath,
    identity: relayIdentity,
    sha256,
    environmentPath: `${directory.canonicalPath}${path.delimiter}${identity.normalizedPath}`
  }
}

async function revalidateFile(identity: CanonicalFileIdentity, label: string): Promise<void> {
  const current = await existingFileIdentity(identity.lexicalPath)
  if (
    current.canonicalPath !== identity.canonicalPath ||
    current.device !== identity.device ||
    current.inode !== identity.inode ||
    current.mode !== identity.mode ||
    current.byteLength !== identity.byteLength ||
    current.sha256 !== identity.sha256
  ) {
    throw new Error(`${label} "${identity.lexicalPath}" changed after launch identity compilation.`)
  }
}

async function revalidateDirectory(identity: CanonicalDirectoryIdentity): Promise<void> {
  const current = await directoryIdentity(identity.lexicalPath)
  if (
    current.canonicalPath !== identity.canonicalPath ||
    current.exists !== identity.exists ||
    current.device !== identity.device ||
    current.inode !== identity.inode
  ) {
    throw new Error(
      `Provider PATH directory "${identity.lexicalPath}" changed after launch identity compilation.`
    )
  }
}

export async function revalidateProviderLaunchIdentity(
  identity: ProviderLaunchIdentity,
  relay: MaterializedProviderRelay | null = null
): Promise<void> {
  await Promise.all(identity.pathDirectories.map(revalidateDirectory))
  const files = [
    identity.entry,
    ...identity.shebangChain.flatMap((hop) => [
      hop.script,
      hop.declaredInterpreter,
      ...(hop.lookup === null ? [] : [hop.lookup.executable])
    ]),
    identity.terminalExecutable,
    identity.relayInterpreter
  ]
  const unique = files.filter(
    (file, index) =>
      files.findIndex(
        (candidate) => candidate.device === file.device && candidate.inode === file.inode
      ) === index
  )
  await Promise.all(unique.map((file) => revalidateFile(file, "Provider launch executable")))
  if (relay !== null) {
    await revalidateDirectory(relay.directory)
    if (relay.identity.sha256 !== relay.sha256) {
      throw new Error(`Provider relay "${relay.path}" has an invalid content binding.`)
    }
    await revalidateFile(relay.identity, "Provider relay")
  }
}
