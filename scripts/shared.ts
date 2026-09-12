/** Shared by the local scripts: secrets from .dev.vars (or the environment) and the JSON-file state store. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import type { SyncState, SyncStore } from '../src/sync'

export const statePath = process.env.NTS_SPOTIFY_STATE || join(homedir(), '.config', 'nts-to-spotify', 'state.json')

export const env: Record<string, string | undefined> = { ...process.env }
const varsPath = join(process.cwd(), '.dev.vars')
if (existsSync(varsPath)) {
  for (const l of readFileSync(varsPath, 'utf8').split('\n')) {
    const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/)
    if (m && !env[m[1]]) env[m[1]] = m[2]
  }
}

export const store: SyncStore = {
  async get() {
    if (!existsSync(statePath)) return null
    return JSON.parse(readFileSync(statePath, 'utf8')) as SyncState // a corrupt file must abort, not reset
  },
  async put(s) {
    mkdirSync(dirname(statePath), { recursive: true })
    writeFileSync(statePath, JSON.stringify(s, null, 2))
  },
}
