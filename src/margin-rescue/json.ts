// Canonical JSON for evidence and scenario ids: bigints as decimal strings, object
// keys sorted, no whitespace. Two runs over the same data hash identically.
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, openSync, fsyncSync, closeSync } from "node:fs"
import { dirname } from "node:path"

export function toPlain(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString()
  if (Array.isArray(value)) return value.map(toPlain)
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as object).sort()) {
      const v = (value as Record<string, unknown>)[key]
      if (v !== undefined) out[key] = toPlain(v)
    }
    return out
  }
  return value
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(toPlain(value))
}

export function prettyJson(value: unknown): string {
  return JSON.stringify(toPlain(value), null, 2) + "\n"
}

export function sha256Hex(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex")
}

// Write through a temp file, fsync it, then rename, so a crash never leaves a torn file.
export function writeFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, content)
    const fd = openSync(tmp, "r")
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, path)
  } catch (e) {
    // A write that failed leaves no half-done copy beside the file it meant to replace.
    try {
      rmSync(tmp, { force: true })
    } catch {
      // the original error matters more
    }
    throw e
  }
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T
}
