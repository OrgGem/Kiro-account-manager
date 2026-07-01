import { fetch, ProxyAgent } from 'undici'
import { writeKiroAuthTokenFile, readKiroAuthTokenFile } from './kiroAuthSync'

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

export async function ssoDeviceAuth(bearerToken: string, region: string = 'us-east-1', startUrl: string = 'https://view.awsapps.com/start', proxyUrl?: string): Promise<SsoAuthResult> {
  const oidcBase = `https://oidc.${region}.amazonaws.com`
  const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined
  const scopes = [
    'codewhisperer:analysis', 
    'codewhisperer:completions', 
    'codewhisperer:conversations', 
    'codewhisperer:taskassist', 
    'codewhisperer:transformations'
  ]

  let clientId: string, clientSecret: string
  let deviceCode: string, userCode: string
  let deviceSessionToken: string
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

    const { exec } = require('child_process')
    const command = process.platform === 'win32' ? `start "" "${urlToOpen}"` : process.platform === 'darwin' ? `open "${urlToOpen}"` : `xdg-open "${urlToOpen}"`
    exec(command, (err: any) => {
      if (err) console.error('Failed to open browser automatically. Please open the URL manually.')
    })
  } catch (e) {
    return { success: false, error: `Device auth failed: ${e}` }
  }

  // We can skip step 3-6 (automatic approval) because this is a CLI and we can just wait for user to approve it manually via the URL and user code above.
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
