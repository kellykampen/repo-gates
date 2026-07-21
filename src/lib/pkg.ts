/** Load the consumer repo's root package.json scripts map. */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

type PackageJson = { scripts?: Record<string, string> };

export function loadScripts(repoRoot: string): Record<string, string> {
  const packageJsonPath = resolve(repoRoot, "package.json");
  if (!existsSync(packageJsonPath)) return {};
  const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as PackageJson;
  return pkg.scripts ?? {};
}
