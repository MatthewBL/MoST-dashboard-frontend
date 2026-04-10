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

function parsePortToken(token) {
  const numeric = Number(String(token || '').trim())
  if (!Number.isInteger(numeric) || numeric <= 0) {
    return null
  }
  return numeric
}

function buildPortList(values, fallbackPort) {
  const listRaw = values.REMOTE_TUNNEL_PORTS || ''
  const fromList = listRaw
    .split(',')
    .map((item) => parsePortToken(item))
    .filter(Boolean)

  if (fromList.length > 0) {
    return [...new Set(fromList)]
  }

  const single = parsePortToken(values.REMOTE_TUNNEL_PORT)
  if (single !== null) {
    return [single]
  }

  return [fallbackPort]
}

function buildApiBaseByPort(apiBaseUrl, ports) {
  try {
    const parsed = new URL(apiBaseUrl)
    const entries = {}

    for (const port of ports) {
      const perPort = new URL(parsed.toString())
      perPort.port = String(port)
      entries[port] = perPort.toString().replace(/\/$/, '')
    }

    return entries
  } catch {
    return Object.fromEntries(ports.map((port) => [port, `http://localhost:${port}`]))
  }
}

function buildBaseConfig(values) {
  const apiBaseUrl = values.VITE_API_BASE_URL || 'http://localhost:4000'
  let fallbackPort = 4000

  try {
    fallbackPort = Number(new URL(apiBaseUrl).port || 4000)
  } catch {
    fallbackPort = parsePortToken(values.LOCAL_TUNNEL_PORT) || 4000
  }

  const ports = buildPortList(values, fallbackPort)
  const apiBaseByPort = buildApiBaseByPort(apiBaseUrl, ports)

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
    ports,
    apiBaseByPort,
    localBind: values.LOCAL_TUNNEL_BIND || '127.0.0.1',
    remoteHost,
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

function createTunnelState() {
  return {
    child: null,
    running: false,
    startedAt: null,
    lastExitCode: null,
    lastSignal: null,
    lastError: '',
    lastStderr: '',
    restartTimer: null,
    restartCount: 0,
  }
}

const managerState = {
  stopping: false,
}

let config
const tunnels = new Map()

async function checkApiHealth(tunnel) {
  try {
    const target = new URL('/health', tunnel.apiBaseUrl).toString()
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

function buildSshArgs(tunnel) {
  const host = formatHost(config)
  const forward = `${config.localBind}:${tunnel.localPort}:${config.remoteTargetHost}:${tunnel.remotePort}`

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

function scheduleRestart(tunnel, reason) {
  if (tunnel.state.restartTimer || managerState.stopping) {
    return
  }

  tunnel.state.restartTimer = setTimeout(() => {
    tunnel.state.restartTimer = null
    startTunnel(tunnel, `auto-restart:${reason}`)
  }, 3000)
}

function stopTunnel(tunnel) {
  if (!tunnel.state.child) {
    return
  }

  const child = tunnel.state.child
  child.kill('SIGTERM')

  setTimeout(() => {
    if (tunnel.state.child && tunnel.state.child.pid === child.pid) {
      child.kill('SIGKILL')
    }
  }, 2000)
}

function startTunnel(tunnel, source) {
  if (!config.remoteTargetHost) {
    tunnel.state.lastError = 'REMOTE_TUNNEL_HOST or REMOTE_TUNNEL_TARGET_HOST is required in .env.'
    tunnel.state.running = false
    return
  }

  const destination = formatHost(config)
  if (!destination) {
    tunnel.state.lastError = 'SSH destination is missing. Set REMOTE_TUNNEL_USER and REMOTE_TUNNEL_GATEWAY, or REMOTE_TUNNEL_DESTINATION.'
    tunnel.state.running = false
    return
  }

  if (tunnel.state.child) {
    return
  }

  const args = buildSshArgs(tunnel)

  console.log(`[ssh:${tunnel.port}:${source}] ssh ${args.join(' ')}`)

  tunnel.state.lastError = ''
  tunnel.state.lastStderr = ''
  tunnel.state.running = true
  tunnel.state.startedAt = new Date().toISOString()

  const child = spawn('ssh', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })

  tunnel.state.child = child

  child.stdout.on('data', (chunk) => {
    const text = String(chunk)
    process.stdout.write(`[ssh:${tunnel.port}:${source}] ${text}`)
  })

  child.stderr.on('data', (chunk) => {
    const text = String(chunk).trim()
    if (text) {
      tunnel.state.lastStderr = text
      process.stderr.write(`[ssh:${tunnel.port}:${source}] ${text}\n`)
    }
  })

  child.on('error', (error) => {
    tunnel.state.running = false
    tunnel.state.lastError = error.message
    tunnel.state.child = null
    scheduleRestart(tunnel, 'spawn-error')
  })

  child.on('exit', (code, signal) => {
    tunnel.state.running = false
    tunnel.state.lastExitCode = code
    tunnel.state.lastSignal = signal
    tunnel.state.child = null

    if (!managerState.stopping) {
      tunnel.state.restartCount += 1
      scheduleRestart(tunnel, 'exit')
    }
  })
}

async function restartTunnel(tunnel) {
  if (tunnel.state.restartTimer) {
    clearTimeout(tunnel.state.restartTimer)
    tunnel.state.restartTimer = null
  }

  stopTunnel(tunnel)

  const startedAt = Date.now()
  while (tunnel.state.child && Date.now() - startedAt < 4000) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  startTunnel(tunnel, 'manual-restart')
}

function serializeTunnel(tunnel, apiHealth) {
  return {
    port: tunnel.port,
    running: tunnel.state.running,
    pid: tunnel.state.child?.pid || null,
    startedAt: tunnel.state.startedAt,
    lastExitCode: tunnel.state.lastExitCode,
    lastSignal: tunnel.state.lastSignal,
    lastError: tunnel.state.lastError,
    lastStderr: tunnel.state.lastStderr,
    restartCount: tunnel.state.restartCount,
    apiHealth,
    config: {
      apiBaseUrl: tunnel.apiBaseUrl,
      localBind: config.localBind,
      localPort: tunnel.localPort,
      remoteHost: config.remoteHost,
      remoteTargetHost: config.remoteTargetHost,
      sshDestination: formatHost(config),
      remotePort: tunnel.remotePort,
    },
  }
}

function getRequestedPort(urlObject) {
  const fromPath = /^\/status\/(\d+)$/.exec(urlObject.pathname) || /^\/restart\/(\d+)$/.exec(urlObject.pathname)
  if (fromPath) {
    return parsePortToken(fromPath[1])
  }

  const fromQuery = parsePortToken(urlObject.searchParams.get('port'))
  return fromQuery
}

async function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = []

    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({})
        return
      }

      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        resolve(value && typeof value === 'object' ? value : {})
      } catch {
        resolve({})
      }
    })

    req.on('error', () => resolve({}))
  })
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
  const urlObject = new URL(req.url || '/', 'http://localhost')

  if (req.method === 'OPTIONS') {
    jsonResponse(res, 204, {})
    return
  }

  if (req.method === 'GET' && (urlObject.pathname === '/status' || /^\/status\/\d+$/.test(urlObject.pathname))) {
    const requestedPort = getRequestedPort(urlObject)

    if (requestedPort !== null) {
      const tunnel = tunnels.get(requestedPort)
      if (!tunnel) {
        jsonResponse(res, 404, { error: `Tunnel for port ${requestedPort} not configured.` })
        return
      }

      const apiHealth = await checkApiHealth(tunnel)
      jsonResponse(res, 200, serializeTunnel(tunnel, apiHealth))
      return
    }

    const tunnelStatuses = await Promise.all(
      [...tunnels.values()].map(async (tunnel) => {
        const apiHealth = await checkApiHealth(tunnel)
        return serializeTunnel(tunnel, apiHealth)
      }),
    )

    jsonResponse(res, 200, {
      ports: config.ports,
      tunnels: tunnelStatuses,
    })
    return
  }

  if (req.method === 'POST' && (urlObject.pathname === '/restart' || /^\/restart\/\d+$/.test(urlObject.pathname))) {
    const body = await readJsonBody(req)
    const fromBody = parsePortToken(body?.port)
    const requestedPort = getRequestedPort(urlObject) ?? fromBody

    if (requestedPort !== null) {
      const tunnel = tunnels.get(requestedPort)
      if (!tunnel) {
        jsonResponse(res, 404, { error: `Tunnel for port ${requestedPort} not configured.` })
        return
      }

      await restartTunnel(tunnel)
      jsonResponse(res, 200, { ok: true, message: `Tunnel ${requestedPort} restart requested.`, port: requestedPort })
      return
    }

    const defaultPort = config.ports[0]
    const tunnel = tunnels.get(defaultPort)
    if (!tunnel) {
      jsonResponse(res, 500, { error: 'No tunnel is configured.' })
      return
    }

    await restartTunnel(tunnel)
    jsonResponse(res, 200, { ok: true, message: `Tunnel ${defaultPort} restart requested.`, port: defaultPort })
    return
  }

  if (req.method === 'GET' && urlObject.pathname === '/health') {
    jsonResponse(res, 200, { ok: true, service: 'tunnel-manager' })
    return
  }

  jsonResponse(res, 404, { error: 'Not found' })
}

async function main() {
  const fileEnv = await loadEnv()
  const mergedEnv = { ...fileEnv, ...process.env }
  config = buildBaseConfig(mergedEnv)

  for (const port of config.ports) {
    const tunnel = {
      port,
      localPort: port,
      remotePort: port,
      apiBaseUrl: config.apiBaseByPort[port],
      state: createTunnelState(),
    }

    tunnels.set(port, tunnel)
    startTunnel(tunnel, 'startup')
  }

  const server = http.createServer((req, res) => {
    requestHandler(req, res).catch((error) => {
      jsonResponse(res, 500, {
        error: error instanceof Error ? error.message : 'Unhandled manager error.',
      })
    })
  })

  server.listen(config.managerPort, () => {
    console.log(`Tunnel manager listening on http://localhost:${config.managerPort}`)
    console.log(`Managed ports: ${config.ports.join(', ')}`)
  })

  const shutdown = () => {
    managerState.stopping = true

    for (const tunnel of tunnels.values()) {
      if (tunnel.state.restartTimer) {
        clearTimeout(tunnel.state.restartTimer)
        tunnel.state.restartTimer = null
      }

      stopTunnel(tunnel)
    }

    server.close(() => process.exit(0))
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
