#!/usr/bin/env node
/**
 * Cloudflare helper — one command each, nothing to edit by hand:
 *
 *   npm run deploy        log in if needed → find or create the STATE KV namespace → upload
 *                         .dev.vars as secrets → deploy the Worker + 15-min cron
 *   npm run state:push    copy this Mac's state up to the Worker's KV
 *   npm run status        ask the deployed Worker what it has done
 *
 * The KV namespace id is per Cloudflare account, so it is remembered in the gitignored
 * .dev.vars (KV_NAMESPACE_ID=…) rather than in wrangler.jsonc, which stays shareable.
 * Node 18+, no deps beyond wrangler (fetched by npx).
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const cmd = process.argv[2]
const WORKER = 'nts-to-spotify'
const STATE_KEY = 'nts-spotify:state'
const DEPLOY_CONFIG = '.wrangler.deploy.jsonc' // generated, gitignored

const fail = (m) => { console.error(`\n✗ ${m}`); process.exit(1) }
const vars = () => {
  const out = {}
  if (existsSync('.dev.vars')) for (const l of readFileSync('.dev.vars', 'utf8').split('\n')) {
    const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/)
    if (m) out[m[1]] = m[2]
  }
  return out
}
/** Run wrangler. capture=true runs it non-interactively (no prompts) and returns stdout. */
const wrangler = (args, { capture = false } = {}) => {
  const r = spawnSync('npx', ['--yes', 'wrangler', ...args], { stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', encoding: 'utf8', shell: process.platform === 'win32' })
  if (r.status !== 0) { if (r.stdout) console.log(r.stdout); fail(`wrangler ${args[0]} ${args[1] ?? ''} failed`) }
  return r.stdout ?? ''
}
const remember = (key, value) => {
  const cur = vars()
  if (cur[key] === value) return
  appendFileSync('.dev.vars', `\n${key}=${value}\n`)
}

function ensureLogin() {
  const r = spawnSync('npx', ['--yes', 'wrangler', 'whoami'], { encoding: 'utf8', shell: process.platform === 'win32' })
  if (/not authenticated/i.test(`${r.stdout}${r.stderr}`)) {
    console.log('Logging in to Cloudflare (a browser tab opens; create a free account if you have none)…')
    wrangler(['login'])
  }
}

function ensureNamespaceId(env) {
  if (env.KV_NAMESPACE_ID) return env.KV_NAMESPACE_ID
  let id
  const listed = wrangler(['kv', 'namespace', 'list'], { capture: true })
  try {
    const arr = JSON.parse(listed.slice(listed.indexOf('['), listed.lastIndexOf(']') + 1))
    id = arr.find((n) => n.title === 'STATE' || n.title === `${WORKER}-STATE`)?.id
  } catch { /* no namespaces yet */ }
  if (id) console.log(`✓ reusing your existing STATE namespace (${id})`)
  else {
    console.log('Creating the STATE namespace (where the sync keeps its memory)…')
    const out = wrangler(['kv', 'namespace', 'create', 'STATE', '--config', DEPLOY_CONFIG], { capture: true })
    id = out.match(/"id":\s*"([0-9a-f]{32})"/)?.[1] ?? out.match(/\b([0-9a-f]{32})\b/)?.[1]
    if (!id) fail('could not read the new namespace id from wrangler output')
    console.log(`✓ created STATE namespace (${id})`)
  }
  remember('KV_NAMESPACE_ID', id)
  return id
}

function writeDeployConfig(id) {
  const base = readFileSync('wrangler.jsonc', 'utf8')
  writeFileSync(DEPLOY_CONFIG, base.replace('REPLACE_WITH_YOUR_KV_NAMESPACE_ID', id))
}

if (!existsSync('.dev.vars')) fail('no .dev.vars yet — run `npm run setup` first')
const env = vars()

if (cmd === 'deploy') {
  ensureLogin()
  writeDeployConfig('00000000000000000000000000000000') // create-namespace needs a parsable config
  const id = ensureNamespaceId(env)
  writeDeployConfig(id)
  // Secrets: everything in .dev.vars except the namespace id (which is config, not a secret).
  const secrets = Object.entries(vars()).filter(([k]) => k !== 'KV_NAMESPACE_ID').map(([k, v]) => `${k}=${v}`).join('\n') + '\n'
  writeFileSync('.wrangler.secrets.env', secrets)
  try {
    wrangler(['secret', 'bulk', '.wrangler.secrets.env', '--config', DEPLOY_CONFIG, '--name', WORKER])
    const out = wrangler(['deploy', '--config', DEPLOY_CONFIG], { capture: true })
    console.log(out)
    const url = out.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/)?.[0]
    if (url) remember('WORKER_URL', url)
  } finally {
    writeFileSync('.wrangler.secrets.env', '')
  }
  console.log('\n✓ deployed. It now runs every 15 minutes on Cloudflare. Next: npm run state:push')
} else if (cmd === 'state:push') {
  const id = env.KV_NAMESPACE_ID
  if (!id) fail('no KV_NAMESPACE_ID in .dev.vars — run `npm run deploy` first')
  const statePath = process.env.NTS_SPOTIFY_STATE || join(homedir(), '.config', WORKER, 'state.json')
  if (!existsSync(statePath)) fail(`no local state at ${statePath} — run \`npm run sync\` first`)
  wrangler(['kv', 'key', 'put', '--namespace-id', id, '--remote', STATE_KEY, '--path', statePath])
  console.log('✓ state copied up — Cloudflare carries on from where this Mac got to')
} else if (cmd === 'status') {
  const url = process.argv[3] || env.WORKER_URL
  if (!url) fail('no WORKER_URL in .dev.vars — run `npm run deploy` first, or pass the URL: npm run status -- https://…workers.dev')
  const r = await fetch(`${url.replace(/\/$/, '')}/status`, { headers: { authorization: `Bearer ${env.SYNC_TOKEN}` } })
  console.log(await r.text())
} else {
  fail('usage: node scripts/cf.mjs deploy | state:push | status [url]')
}
