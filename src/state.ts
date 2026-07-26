import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

export type Provider = "anthropic" | "glm"

export interface BridgyState {
  projects: Record<string, Provider>
  default: Provider
}

export const stateDir = path.join(os.homedir(), ".config", "cc-gg-bridgy")
export const stateFile = path.join(stateDir, "state.json")

// The shim compares keys against `pwd -P`, so keys must be physical paths.
export function canonical(projectPath: string): string {
  try {
    return fs.realpathSync(projectPath)
  } catch {
    return projectPath
  }
}

export function readState(): BridgyState {
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile, "utf8"))
    return {
      projects: raw.projects ?? {},
      default: raw.default === "glm" ? "glm" : "anthropic",
    }
  } catch {
    return { projects: {}, default: "anthropic" }
  }
}

export function providerFor(projectPath: string): Provider {
  const s = readState()
  return s.projects[canonical(projectPath)] ?? s.default
}

// Unique temp name per write: two windows toggling concurrently must never
// rename each other's temp away; pretty-printed output is part of the shim's
// parse contract (one "key": "value" pair per line).
export function setProvider(projectPath: string, provider: Provider): void {
  const s = readState()
  s.projects[canonical(projectPath)] = provider
  fs.mkdirSync(stateDir, { recursive: true })
  const tmp = `${stateFile}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2))
  fs.renameSync(tmp, stateFile)
}
