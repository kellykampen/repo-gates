/** Shared filesystem helpers for the scan-based gates. */

import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Recursively yield every file under `dir`, pruning any directory whose
 *  name is in `excludeDirSegments`. Missing directories yield nothing.
 *  Uses `lstatSync` and skips symlinks so the scan can't follow a link out
 *  of the tree or loop on a cyclic symlink. */
export function* walk(dir: string, excludeDirSegments: readonly string[]): Generator<string> {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    if (excludeDirSegments.includes(entry)) continue;
    const full = join(dir, entry);
    const st = lstatSync(full);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      yield* walk(full, excludeDirSegments);
    } else if (st.isFile()) {
      yield full;
    }
  }
}

/** Line count: newline bytes, plus one for a final line with no trailing
 *  newline (so a non-empty file always counts ≥1 line). */
export function countLines(filePath: string): number {
  const buf = readFileSync(filePath);
  if (buf.length === 0) return 0;
  let count = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) count++;
  }
  if (buf[buf.length - 1] !== 0x0a) count++;
  return count;
}

export function hasExtension(name: string, extensions: readonly string[]): boolean {
  return extensions.some((ext) => name.endsWith(ext));
}
