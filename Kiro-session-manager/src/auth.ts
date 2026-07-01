import { fetch, ProxyAgent } from 'undici'
import * as crypto from 'crypto'
import * as http from 'http'
import { KIRO_OIDC_SCOPES } from './kiroAuthSync'

export interface SsoAuthResult {
  success: boolean
  accessToken?: string
  refreshToken?: string
  clientId?: string
  clientSecret?: string
  region?: string
  expiresIn?: number
  error?: string
}

// ---------------------------------------------------------------------------
// Cross-platform browser opener
// ---------------------------------------------------------------------------

function openExternalUrl(url: string): void {
  const { spawn } = require('child_process') as typeof import('child_process')

  switch (process.platform) {
    case 'win32':
      // Use cmd /c start to avoid shell injection – URL is passed as a separate arg
      spawn('cmd', ['/c', 'start', '""', url], { stdio: 'ignore', shell: false })
      break
    case 'darwin':
      spawn('open', [url], { stdio: 'ignore' })
      break
    default:
      spawn('xdg-open', [url], { stdio: 'ignore' })
      break
  }
}

// ---------------------------------------------------------------------------
// IAM Identity Center PKCE Authorization Code flow
// ---------------------------------------------------------------------------

export async function iamSsoPkceAuth(
  region: string = 'us-east-1',
  startUrl: string,
  proxyUrl?: string,
  timeoutMs: number = 10 * 60 * 1000
): Promise<SsoAuthResult> {
  // Validate startUrl
  if (!startUrl || !startUrl.startsWith('https://')) {
    return { success: false, error: 'SSO Start URL must start with https://' }
  }

  const oidcBase = `https://oidc.${region}.amazonaws.com`
  const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined
  const scopes = KIRO_OIDC_SCOPES

  // ── Step 1: Register OIDC client (authorization_code grant) ──────────────
  console.log('[PKCE] Step 1: Registering OIDC client (authorization_code)...')
  let clientId: string, clientSecret: string

  try {
    const regRes = await fetch(`${oidcBase}/client/register`, {
      method: 'POST',
      dispatcher,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientName: 'Kiro Session Manager',
        clientType: 'public',
        scopes,
        grantTypes: ['authorization_code', 'refresh_token'],
        redirectUris: ['http://127.0.0.1/oauth/callback'],
        issuerUrl: startUrl
      })
    })

    if (!regRes.ok) {
      const errText = await regRes.text()
      console.error('[PKCE] Client registration failed:', regRes.status, errText)
      return { success: false, error: `Client registration failed (${regRes.status}): ${errText}` }
    }

    const regData = await regRes.json() as any
    clientId = regData.clientId
    clientSecret = regData.clientSecret
    console.log('[PKCE] Client registered:', clientId.substring(0, 20) + '...')
  } catch (e) {
    return { success: false, error: `Client registration failed: ${e}` }
  }

  // ── Step 2: Generate PKCE code verifier / challenge + state ──────────────
  const codeVerifier = crypto.randomBytes(32).toString('base64url')
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url')
  const state = crypto.randomUUID()

  // ── Step 3: Start local HTTP callback server on ephemeral port ───────────
  console.log('[PKCE] Step 2: Starting local OAuth callback server...')

  const port = await new Promise<number>((resolve, reject) => {
    const tmpServer = http.createServer()
    tmpServer.listen(0, '127.0.0.1', () => {
      const addr = tmpServer.address()
      if (addr && typeof addr === 'object') {
        const p = addr.port
        tmpServer.close(() => resolve(p))
      } else {
        reject(new Error('Could not acquire ephemeral port'))
      }
    })
  })

  const redirectUri = `http://127.0.0.1:${port}/oauth/callback`
  console.log('[PKCE] Redirect URI:', redirectUri)

  return new Promise<SsoAuthResult>((resolve) => {
    let settled = false

    const settle = (result: SsoAuthResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      server.close()
      resolve(result)
    }

    // Timeout guard
    const timer = setTimeout(() => {
      settle({ success: false, error: `Timeout: no OAuth callback received within ${timeoutMs / 1000}s` })
    }, timeoutMs)

    // Callback server
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url || '', `http://127.0.0.1:${port}`)

      if (url.pathname !== '/oauth/callback') {
        res.writeHead(404)
        res.end('Not Found')
        return
      }

      // Check for error from IdP
      const error = url.searchParams.get('error')
      if (error) {
        const desc = url.searchParams.get('error_description') || error
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end('<html><body><h1>Authorization Failed</h1><p>You may close this window.</p></body></html>')
        settle({ success: false, error: `Authorization error: ${desc}` })
        return
      }

      // Validate state
      const returnedState = url.searchParams.get('state')
      if (returnedState !== state) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end('<html><body><h1>Authorization Failed</h1><p>State mismatch – please try again.</p></body></html>')
        settle({ success: false, error: 'State mismatch' })
        return
      }

      // Require authorization code
      const code = url.searchParams.get('code')
      if (!code) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end('<html><body><h1>Authorization Failed</h1><p>No authorization code received.</p></body></html>')
        settle({ success: false, error: 'No authorization code received' })
        return
      }

      // ── Token exchange ───────────────────────────────────────────────
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end('<html><body><h1>Authorization Successful!</h1><p>Exchanging token… You may close this window.</p></body></html>')

      try {
        const tokenRes = await fetch(`${oidcBase}/token`, {
          method: 'POST',
          dispatcher,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            clientId,
            clientSecret,
            grantType: 'authorization_code',
            redirectUri,
            code,
            codeVerifier
          })
        })

        if (!tokenRes.ok) {
          const errText = await tokenRes.text()
          console.error('[PKCE] Token exchange failed:', tokenRes.status, errText)
          settle({ success: false, error: `Token exchange failed (${tokenRes.status}): ${errText}` })
          return
        }

        const tokenData = await tokenRes.json() as any
        console.log('[PKCE] Token obtained successfully!')
        settle({
          success: true,
          accessToken: tokenData.accessToken,
          refreshToken: tokenData.refreshToken,
          clientId,
          clientSecret,
          region,
          expiresIn: tokenData.expiresIn
        })
      } catch (tokenError: any) {
        console.error('[PKCE] Token exchange error:', tokenError)
        settle({ success: false, error: `Token exchange error: ${tokenError.message || tokenError}` })
      }
    })

    server.listen(port, '127.0.0.1', () => {
      console.log('[PKCE] OAuth callback server listening on port', port)

      // ── Step 4: Build authorize URL & open browser ─────────────────
      const authorizeParams = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirectUri,
        scopes: scopes.join(','),
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256'
      })
      const authorizeUrl = `${oidcBase}/authorize?${authorizeParams.toString()}`

      console.log(`\n========================================`)
      console.log(`[PKCE] Please open the following URL to authorize:`)
      console.log(authorizeUrl)
      console.log(`========================================\n`)

      openExternalUrl(authorizeUrl)
    })
  })
}

// ---------------------------------------------------------------------------
// Device Code flow (legacy / fallback)
// ---------------------------------------------------------------------------

export async function ssoDeviceAuth(bearerToken: string, region: string = 'us-east-1', startUrl: string = 'https://view.awsapps.com/start', proxyUrl?: string): Promise<SsoAuthResult> {
  const oidcBase = `https://oidc.${region}.amazonaws.com`
  const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined
  const scopes = KIRO_OIDC_SCOPES

  let clientId: string, clientSecret: string
  let deviceCode: string, userCode: string
  let interval = 1

  console.log('[SSO] Step 1: Registering OIDC client...')
  try {
    const regRes = await fetch(`${oidcBase}/client/register`, {
      method: 'POST',
      dispatcher,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientName: 'Kiro Session Manager',
        clientType: 'public',
        scopes,
        grantTypes: ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'],
        issuerUrl: startUrl
      })
    })
    if (!regRes.ok) throw new Error(`Register failed: ${regRes.status}`)
    const regData = await regRes.json() as any
    clientId = regData.clientId
    clientSecret = regData.clientSecret
  } catch (e) {
    return { success: false, error: `Client registration failed: ${e}` }
  }

  console.log('[SSO] Step 2: Starting device authorization...')
  try {
    const devRes = await fetch(`${oidcBase}/device_authorization`, {
      method: 'POST',
      dispatcher,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, clientSecret, startUrl })
    })
    if (!devRes.ok) throw new Error(`Device auth failed: ${devRes.status}`)
    const devData = await devRes.json() as any
    deviceCode = devData.deviceCode
    userCode = devData.userCode
    interval = devData.interval || 1
    
    const urlToOpen = devData.verificationUriComplete || devData.verificationUri || startUrl
    
    console.log(`\n========================================`)
    console.log(`[SSO ACTION REQUIRED]`)
    console.log(`Please go to: ${urlToOpen}`)
    console.log(`And enter code: ${userCode} (if prompted)`)
    console.log(`========================================\n`)

    openExternalUrl(urlToOpen)
  } catch (e) {
    return { success: false, error: `Device auth failed: ${e}` }
  }

  console.log('[SSO] Step 3: Polling for token (waiting for user approval)...')
  const startTime = Date.now()
  const timeout = 120000 // 2 minutes

  while (Date.now() - startTime < timeout) {
    await new Promise(r => setTimeout(r, interval * 1000))
    
    try {
      const tokenRes = await fetch(`${oidcBase}/token`, {
        method: 'POST',
        dispatcher,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId,
          clientSecret,
          grantType: 'urn:ietf:params:oauth:grant-type:device_code',
          deviceCode
        })
      })

      if (tokenRes.ok) {
        const tokenData = await tokenRes.json() as any
        console.log('[SSO] Token obtained successfully!')
        return {
          success: true,
          accessToken: tokenData.accessToken,
          refreshToken: tokenData.refreshToken,
          clientId,
          clientSecret,
          region,
          expiresIn: tokenData.expiresIn
        }
      }

      if (tokenRes.status === 400) {
        const errData = await tokenRes.json() as any
        if (errData.error === 'authorization_pending') {
          continue 
        } else if (errData.error === 'slow_down') {
          interval += 5
        } else {
          return { success: false, error: `Token failed: ${errData.error}` }
        }
      }
    } catch (e) {
      console.error('[SSO] Token poll error:', e)
    }
  }

  return { success: false, error: 'Timeout waiting for approval' }
}

// ---------------------------------------------------------------------------
// OIDC Token Refresh
// ---------------------------------------------------------------------------

export async function refreshOidcToken(region: string, clientId: string, clientSecret: string, refreshToken: string, proxyUrl?: string) {
  const oidcBase = `https://oidc.${region}.amazonaws.com`
  const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined
  const tokenRes = await fetch(`${oidcBase}/token`, {
    method: 'POST',
    dispatcher,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientId,
      clientSecret,
      grantType: 'refresh_token',
      refreshToken
    })
  })

  if (!tokenRes.ok) {
    throw new Error(`Refresh failed: ${tokenRes.status}`)
  }

  return await tokenRes.json() as any
}
