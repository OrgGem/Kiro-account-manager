#!/usr/bin/env node
import { Command } from 'commander'
import { ssoDeviceAuth, refreshOidcToken } from './auth'
import { writeKiroAuthTokenFile, readKiroAuthTokenFile, readClientRegistration, KIRO_DEFAULT_START_URL, KiroAuthTokenFile } from './kiroAuthSync'
import { readConfig, writeConfig } from './config'

const program = new Command()
const REFRESH_THRESHOLD_MS = 10 * 60 * 1000

program
  .name('kiro-session-manager')
  .description('CLI to manage Kiro authentication and session auto-refresh')
  .version('1.0.0')

program
  .command('config')
  .description('Set configuration values like region and startUrl')
  .option('-r, --region <region>', 'SSO region (e.g. us-east-1)')
  .option('-u, --startUrl <url>', 'SSO Start URL')
  .option('-p, --proxy <url>', 'HTTP/HTTPS Proxy URL (e.g. http://127.0.0.1:1080)')
  .action(async (options) => {
    const newConfig: any = {}
    if (options.region) newConfig.region = options.region
    if (options.startUrl) newConfig.startUrl = options.startUrl
    if (options.proxy) newConfig.proxyUrl = options.proxy

    if (Object.keys(newConfig).length === 0) {
      const current = await readConfig()
      console.log('Current configuration:', current)
    } else {
      await writeConfig(newConfig)
      console.log('Configuration updated successfully.')
    }
  })

async function performLogin(options: any) {
  const config = await readConfig()
  const region = options.region || config.region || 'us-east-1'
  const startUrl = options.startUrl || config.startUrl || KIRO_DEFAULT_START_URL
  const proxyUrl = options.proxy || config.proxyUrl

  console.log(`Starting SSO login in region ${region}...`)
  if (proxyUrl) console.log(`Using proxy: ${proxyUrl}`)

  const result = await ssoDeviceAuth('', region, startUrl, proxyUrl)
  if (!result.success || !result.accessToken || !result.refreshToken || !result.clientId || !result.clientSecret) {
    console.error('Login failed:', result.error || 'Missing required credentials')
    process.exit(1)
  }

  await writeConfig({ clientId: result.clientId, clientSecret: result.clientSecret, region, startUrl })

  const expiresAt = new Date(Date.now() + (result.expiresIn || 28800) * 1000).toISOString()

  const writeResult = await writeKiroAuthTokenFile({
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    expiresAtIso: expiresAt,
    authMethod: 'IdC',
    provider: 'Enterprise',
    region,
    startUrl,
    clientId: result.clientId,
    clientSecret: result.clientSecret
  })

  console.log(`Login successful! Token saved to ${writeResult.tokenPath}`)
  if (writeResult.clientRegPath) console.log(`Client registration saved to ${writeResult.clientRegPath}`)
}

async function resolveClientCredentials(token: KiroAuthTokenFile) {
  const registration = await readClientRegistration(token.clientIdHash)
  if (registration) return registration

  const config = await readConfig()
  if (config.clientId && config.clientSecret) {
    return { clientId: config.clientId, clientSecret: config.clientSecret }
  }

  return null
}

async function refreshCurrentToken(options: any): Promise<boolean> {
  const config = await readConfig()
  const proxyUrl = options.proxy || config.proxyUrl
  const currentToken = await readKiroAuthTokenFile()
  if (!currentToken || !currentToken.refreshToken) {
    console.log('[AutoRefresh] No valid token found in cache.')
    return false
  }

  if (currentToken.authMethod === 'social') {
    console.error('[AutoRefresh] Social auth refresh is not supported by this CLI yet.')
    return false
  }

  const credentials = await resolveClientCredentials(currentToken)
  if (!credentials) {
    console.error('[AutoRefresh] Cannot refresh: missing client registration cache and config fallback credentials.')
    return false
  }

  const region = currentToken.region || config.region || 'us-east-1'
  const newData = await refreshOidcToken(region, credentials.clientId, credentials.clientSecret, currentToken.refreshToken, proxyUrl)
  const newExpiresAt = new Date(Date.now() + (newData.expiresIn || 28800) * 1000).toISOString()

  await writeKiroAuthTokenFile({
    accessToken: newData.accessToken,
    refreshToken: newData.refreshToken || currentToken.refreshToken,
    expiresAtIso: newExpiresAt,
    authMethod: currentToken.authMethod || 'IdC',
    provider: currentToken.provider || 'Enterprise',
    region,
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    clientIdHash: currentToken.clientIdHash,
    profileArn: currentToken.profileArn
  })
  console.log(`[AutoRefresh] Token refreshed successfully! New expiration: ${newExpiresAt}`)
  return true
}

async function runRefreshCycle(options: any): Promise<boolean> {
  const currentToken = await readKiroAuthTokenFile()
  if (!currentToken || !currentToken.refreshToken) {
    console.log('[AutoRefresh] No valid token found in cache.')
    return false
  }

  console.log('[AutoRefresh] Checking token expiration...')
  const expiresAt = new Date(currentToken.expiresAt).getTime()
  const timeRemaining = expiresAt - Date.now()

  if (timeRemaining < REFRESH_THRESHOLD_MS) {
    console.log('[AutoRefresh] Token expiring soon. Initiating refresh...')
    return await refreshCurrentToken(options)
  }

  console.log(`[AutoRefresh] Token still valid for ${Math.floor(timeRemaining / 60000)} minutes.`)
  return true
}

async function startRefreshLoop(options: any) {
  const config = await readConfig()
  const proxyUrl = options.proxy || config.proxyUrl
  const intervalMs = parseInt(options.interval) * 60 * 1000
  console.log(`Starting auto-refresh loop (interval: ${options.interval} minutes)`)
  if (proxyUrl) console.log(`Using proxy: ${proxyUrl}`)

  try {
    await runRefreshCycle(options)
  } catch (err: any) {
    console.error('[AutoRefresh] Error during initial refresh cycle:', err.message || err)
  }

  setInterval(async () => {
    try {
      await runRefreshCycle(options)
    } catch (err: any) {
      console.error('[AutoRefresh] Error during refresh cycle:', err.message || err)
    }
  }, intervalMs)
}

program
  .command('login')
  .description('Login to AWS SSO Enterprise (Device Code Auth)')
  .option('-r, --region <region>', 'SSO region (overrides config)')
  .option('-u, --startUrl <url>', 'SSO Start URL (overrides config)')
  .option('-p, --proxy <url>', 'Proxy URL (overrides config)')
  .action(performLogin)

program
  .command('start-refresh-loop')
  .description('Start a background loop to automatically refresh the token')
  .option('-i, --interval <minutes>', 'Interval in minutes', '5')
  .option('-p, --proxy <url>', 'Proxy URL (overrides config)')
  .action(startRefreshLoop)

program
  .command('start')
  .description('Check if logged in, perform login if needed, then start the refresh loop')
  .option('-r, --region <region>', 'SSO region (overrides config)')
  .option('-u, --startUrl <url>', 'SSO Start URL (overrides config)')
  .option('-p, --proxy <url>', 'Proxy URL (overrides config)')
  .option('-i, --interval <minutes>', 'Interval in minutes', '5')
  .action(async (options) => {
    const currentToken = await readKiroAuthTokenFile()
    let needsLogin = false

    if (!currentToken || !currentToken.refreshToken) {
      needsLogin = true
    } else {
      const timeRemaining = new Date(currentToken.expiresAt).getTime() - Date.now()
      if (timeRemaining <= REFRESH_THRESHOLD_MS) {
        console.log('Token expired or expiring soon. Attempting refresh before login...')
        try {
          needsLogin = !(await refreshCurrentToken(options))
        } catch (err: any) {
          console.error('Refresh failed:', err.message || err)
          needsLogin = true
        }
      }
    }

    if (needsLogin) {
      console.log('No refreshable token found. Initiating login...')
      await performLogin(options)
    } else {
      console.log('Found valid token. Skipping login...')
    }

    await startRefreshLoop(options)
  })

program.addHelpText('after', `
Examples:

  1. Cấu hình thông tin đăng nhập mặc định:
     $ kiro-session config --startUrl "https://my-company.awsapps.com/start" --region us-east-1 --proxy "http://127.0.0.1:1080"

  2. Xem cấu hình hiện tại:
     $ kiro-session config

  3. Bắt đầu đăng nhập SSO:
     $ kiro-session login

  4. Chạy vòng lặp tự động làm mới token mỗi 5 phút (treo ở terminal):
     $ kiro-session start-refresh-loop --interval 5

  5. Khởi chạy thông minh (Tự động login nếu cần, sau đó start-refresh-loop):
     $ kiro-session start --interval 5
`)

program.parse(process.argv)
