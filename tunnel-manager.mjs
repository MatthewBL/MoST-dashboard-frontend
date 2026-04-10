import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ENV_FILE = path.join(__dirname, '.env')
const ENV_EXAMPLE_FILE = path.join(__dirname, '.env.example')

function parseEnvText(text) {
  const values = {}
  const lines = text.split(/\r?\n/)

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) {
      continue
    }

    const separator = trimmed.indexOf('=')
    if (separator === -1) {
      continue
    }

    const key = trimmed.slice(0, separator).trim()
    let value = trimmed.slice(separator + 1).trim()

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }

    if (key) {
      values[key] = value
    }
  }

  return values
}

async function loadEnv() {
  try {
    const text = await fs.readFile(ENV_FILE, 'utf8')
    return parseEnvText(text)
  } catch {
    try {
      const templateText = await fs.readFile(ENV_EXAMPLE_FILE, 'utf8')
      console.warn('Using .env.example because .env was not found.')
      return parseEnvText(templateText)
    } catch {
      return {}
    }
  }
}

function buildConfig(values) {
  const apiBaseUrl = values.VITE_API_BASE_URL || 'http://localhost:4000'
  let localPort = 4000

  try {
    localPort = Number(new URL(apiBaseUrl).port || 80)
  } catch {
    localPort = Number(values.LOCAL_TUNNEL_PORT || 4000)
  }

  const remoteHost = values.REMOTE_TUNNEL_HOST || ''
  const remoteUser = values.REMOTE_TUNNEL_USER || ''
  const remoteGateway = values.REMOTE_TUNNEL_GATEWAY || ''

  let remoteTargetHost = values.REMOTE_TUNNEL_TARGET_HOST || ''
  if (!remoteTargetHost) {
    remoteTargetHost = remoteHost || '127.0.0.1'
  }

  // Backward-compatible behavior: if REMOTE_TUNNEL_USER already contains user@gateway,
  // prefer REMOTE_TUNNEL_HOST as the forwarded target when target is left as localhost.
  if (
    remoteUser.includes('@') &&
    remoteHost &&
    remoteTargetHost === '127.0.0.1'
  ) {
    remoteTargetHost = remoteHost
  }

  return {
    apiBaseUrl,
    localBind: values.LOCAL_TUNNEL_BIND || '127.0.0.1',
    localPort,
    remoteHost,
    remotePort: Number(values.REMOTE_TUNNEL_PORT || localPort),
    remoteTargetHost,
    remoteUser,
    remoteGateway,
    sshDestination: values.REMOTE_TUNNEL_DESTINATION || '',
    identityFile: values.REMOTE_TUNNEL_IDENTITY_FILE || '',
    sshConfigFile: values.REMOTE_TUNNEL_SSH_CONFIG_FILE || '',
    extraArgs: values.REMOTE_TUNNEL_EXTRA_ARGS || '',
    managerPort: Number(values.TUNNEL_MANAGER_PORT || 4100),
  }
}

function formatHost(config) {
  if (config.sshDestination) {
    return config.sshDestination
  }

  if (config.remoteUser.includes('@')) {
    return config.remoteUser
  }

  if (config.remoteGateway) {
    return config.remoteUser ? `${config.remoteUser}@${config.remoteGateway}` : config.remoteGateway
  }

  return config.remoteUser ? `${config.remoteUser}@${config.remoteHost}` : config.remoteHost
}

function splitExtraArgs(value) {
  if (!value) {
    return []
  }
  return value
    .trim()
    .split(/\s+/)
    .filter(Boolean)
}

const state = {
  child: null,
  running: false,
  startedAt: null,
  lastExitCode: null,
  lastSignal: null,
  lastError: '',
  lastStderr: '',
  restartTimer: null,
  stopping: false,
  restartCount: 0,
}

let config

async function checkApiHealth() {
  try {
    const target = new URL('/health', config.apiBaseUrl).toString()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 2500)
    const response = await fetch(target, { signal: controller.signal })
    clearTimeout(timeout)

    if (!response.ok) {
      return { ok: false, message: `API returned ${response.status}` }
    }

    return { ok: true, message: 'API reachable through local tunnel.' }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown API health error.'
    return { ok: false, message }
  }
}

function buildSshArgs() {
  const host = formatHost(config)
  const forward = `${config.localBind}:${config.localPort}:${config.remoteTargetHost}:${config.remotePort}`

  const args = ['-N', '-o', 'ExitOnForwardFailure=yes', '-L', forward]

  if (config.identityFile) {
    args.push('-i', config.identityFile)
  }

  if (config.sshConfigFile) {
    args.push('-F', config.sshConfigFile)
  }

  args.push(...splitExtraArgs(config.extraArgs))
  args.push(host)

  return args
}

function scheduleRestart(reason) {
  if (state.restartTimer || state.stopping) {
    return
  }

  state.restartTimer = setTimeout(() => {
    state.restartTimer = null
    startTunnel(`auto-restart:${reason}`)
  }, 3000)
}

function stopCurrentTunnel() {
  if (!state.child) {
    return
  }

  const child = state.child
  child.kill('SIGTERM')

  setTimeout(() => {
    if (state.child && state.child.pid === child.pid) {
      child.kill('SIGKILL')
    }
  }, 2000)
}

function startTunnel(source) {
  if (!config.remoteTargetHost) {
    state.lastError = 'REMOTE_TUNNEL_HOST or REMOTE_TUNNEL_TARGET_HOST is required in .env.'
    state.running = false
    return
  }

  const destination = formatHost(config)
  if (!destination) {
    state.lastError = 'SSH destination is missing. Set REMOTE_TUNNEL_USER and REMOTE_TUNNEL_GATEWAY, or REMOTE_TUNNEL_DESTINATION.'
    state.running = false
    return
  }

  if (state.child) {
    return
  }

  const args = buildSshArgs()

  console.log(`[ssh:${source}] ssh ${args.join(' ')}`)

  state.lastError = ''
  state.lastStderr = ''
  state.running = true
  state.startedAt = new Date().toISOString()

  const child = spawn('ssh', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })

  state.child = child

  child.stdout.on('data', (chunk) => {
    const text = String(chunk)
    process.stdout.write(`[ssh:${source}] ${text}`)
  })

  child.stderr.on('data', (chunk) => {
    const text = String(chunk).trim()
    if (text) {
      state.lastStderr = text
      process.stderr.write(`[ssh:${source}] ${text}\n`)
    }
  })

  child.on('error', (error) => {
    state.running = false
    state.lastError = error.message
    state.child = null
    scheduleRestart('spawn-error')
  })

  child.on('exit', (code, signal) => {
    state.running = false
    state.lastExitCode = code
    state.lastSignal = signal
    state.child = null

    if (!state.stopping) {
      state.restartCount += 1
      scheduleRestart('exit')
    }
  })
}

async function restartTunnel() {
  if (state.restartTimer) {
    clearTimeout(state.restartTimer)
    state.restartTimer = null
  }

  stopCurrentTunnel()

  const startedAt = Date.now()
  while (state.child && Date.now() - startedAt < 4000) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  startTunnel('manual-restart')
}

function jsonResponse(res, statusCode, payload) {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.end(JSON.stringify(payload))
}

async function requestHandler(req, res) {
  if (req.method === 'OPTIONS') {
    jsonResponse(res, 204, {})
    return
  }

  if (req.method === 'GET' && req.url === '/status') {
    const apiHealth = await checkApiHealth()
    jsonResponse(res, 200, {
      running: state.running,
      pid: state.child?.pid || null,
      startedAt: state.startedAt,
      lastExitCode: state.lastExitCode,
      lastSignal: state.lastSignal,
      lastError: state.lastError,
      lastStderr: state.lastStderr,
      restartCount: state.restartCount,
      apiHealth,
      config: {
        apiBaseUrl: config.apiBaseUrl,
        localBind: config.localBind,
        localPort: config.localPort,
        remoteHost: config.remoteHost,
        remoteTargetHost: config.remoteTargetHost,
        sshDestination: formatHost(config),
        remotePort: config.remotePort,
      },
    })
    return
  }

  if (req.method === 'POST' && req.url === '/restart') {
    await restartTunnel()
    jsonResponse(res, 200, { ok: true, message: 'Tunnel restart requested.' })
    return
  }

  if (req.method === 'GET' && req.url === '/health') {
    jsonResponse(res, 200, { ok: true, service: 'tunnel-manager' })
    return
  }

  jsonResponse(res, 404, { error: 'Not found' })
}

async function main() {
  const fileEnv = await loadEnv()
  const mergedEnv = { ...fileEnv, ...process.env }
  config = buildConfig(mergedEnv)

  startTunnel('startup')

  const server = http.createServer((req, res) => {
    requestHandler(req, res).catch((error) => {
      jsonResponse(res, 500, {
        error: error instanceof Error ? error.message : 'Unhandled manager error.',
      })
    })
  })

  server.listen(config.managerPort, () => {
    console.log(`Tunnel manager listening on http://localhost:${config.managerPort}`)
  })

  const shutdown = () => {
    state.stopping = true
    if (state.restartTimer) {
      clearTimeout(state.restartTimer)
      state.restartTimer = null
    }

    stopCurrentTunnel()
    server.close(() => process.exit(0))
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
