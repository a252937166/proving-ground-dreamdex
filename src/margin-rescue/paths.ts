// Where a live run's files may be: its journals in a private folder (under the
// git-ignored .margin-rescue/, or outside the repository), and their published copies
// only in evidence/margin-rescue/live-write/run-*/. Paths are compared as the file
// system sees them: symbolic links are resolved first, letter case is canonicalised
// (realpath.native) and compared without case where the file system ignores it, and
// .margin-rescue/ itself must be a real folder, so no spelling or link of a path can
// carry a private folder into evidence/ or a published one out of it.
import { existsSync, lstatSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

export const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url))

export class RefusedError extends Error {}

// Text a run records or prints (a reason, an error from the file system): paths in the
// repository are written relative to it and the home folder as ~, so a run's record and
// its console do not carry this machine's layout.
export function localText(text: string, root = REPO_ROOT): string {
  let out = text
  for (const r of new Set([root, canonical(root)])) out = out.split(r.endsWith(sep) ? r : r + sep).join("")
  return out.split(homedir() + sep).join(`~${sep}`)
}

const canonical = (p: string) => {
  try {
    return realpathSync.native(p)
  } catch {
    return p
  }
}

// Paths are compared exactly, after realOf: realpath.native gives every existing component
// its spelling on disk, so a case variant on a case-insensitive volume becomes the real
// folder, and on a case-sensitive volume it stays the separate folder it is.
const norm = (p: string) => p
export const within = (dir: string, p: string) => p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep)

// The real path of `p`: its deepest existing ancestor resolved through symbolic links,
// then the rest of the path as given. A dangling link is refused, since where it would
// lead cannot be known.
export function realOf(p: string): string {
  const rest: string[] = []
  let head = resolve(p)
  for (;;) {
    let link = false
    let exists = false
    try {
      link = lstatSync(head).isSymbolicLink()
      exists = true
    } catch {
      // does not exist (yet)
    }
    if (exists) {
      if (link && !existsSync(head)) throw new RefusedError(`${head} is a symbolic link to nothing`)
      return join(realpathSync.native(head), ...rest)
    }
    const up = dirname(head)
    if (up === head) return join(head, ...rest)
    rest.unshift(basename(head))
    head = up
  }
}

// A run's private folder: under .margin-rescue/ or outside the repository.
export function privateOutDir(out: string | undefined, root = REPO_ROOT, now = Date.now()): string {
  const target = resolve(out ?? join(root, ".margin-rescue", "live", `run-${now}`))
  const real = realOf(target)
  const realRoot = realOf(root)
  if (within(realRoot, real)) {
    const marker = join(root, ".margin-rescue")
    let linked = false
    try {
      linked = lstatSync(marker).isSymbolicLink()
    } catch {
      // created on first use
    }
    if (linked) throw new RefusedError(".margin-rescue is a symbolic link; the private folder must be a real folder in the repository")
    const privateRoot = join(realRoot, ".margin-rescue")
    if (!within(privateRoot, real) || norm(real) === norm(privateRoot)) {
      throw new RefusedError(`${out ?? target} is in the repository but not under .margin-rescue/: a run's journals stay private and are published only with npm run mr:publish-run`)
    }
  }
  return target
}

// Where published live bundles live, and a bundle's folder inside it.
export function liveWriteDir(root = REPO_ROOT): string {
  return join(root, "evidence", "margin-rescue", "live-write")
}

export function publishedBundleDir(to: string, root = REPO_ROOT): string {
  const target = resolve(to)
  if (!/^run-\d+$/.test(basename(target)) || !samePath(dirname(target), liveWriteDir(root))) {
    throw new RefusedError(`${to} is not a bundle folder evidence/margin-rescue/live-write/run-<number>`)
  }
  return target
}

// Is `p` (resolved) shown in the repository's shareable paths: anywhere in the repository
// except the private .margin-rescue/ folder?
export function isPublicPath(p: string, root = REPO_ROOT): boolean {
  const real = realOf(p)
  return within(realOf(root), real) && !within(join(realOf(root), ".margin-rescue"), real)
}

export const samePath = (a: string, b: string) => norm(realOf(a)) === norm(realOf(b))
