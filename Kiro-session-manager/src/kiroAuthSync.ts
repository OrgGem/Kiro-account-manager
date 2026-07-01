import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import * as crypto from 'crypto'

export const KIRO_SSO_CACHE_DIR = path.join(os.homedir(), '.aws', 'sso', 'cache')
export const KIRO_AUTH_TOKEN_PATH = path.join(KIRO_SSO_CACHE_DIR, 'kiro-auth-token.json')
export const KIRO_DEFAULT_START_URL = 'https://view.awsapps.com/start'
export const KIRO_OIDC_SCOPES = [
  'codewhisperer:analysis',
  'codewhisperer:completions',
  'codewhisperer:conversations',
  'codewhisperer:taskassist',
  'codewhisperer:transformations'
]

export const KIRO_BUILDER_ID_PLACEHOLDER_ARN = 'arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX'
export const KIRO_SOCIAL_PROFILE_ARN = 'arn:aws:codewhisperer:us-east-1:699475941385:profile/EHGA3GRVQMUK'

const ENTERPRISE_FALLBACK_ACCOUNT_ID = '610548660232'
const ENTERPRISE_FALLBACK_PROFILE_ID = 'VNECVYCYYAWN'

export function getEnterpriseFallbackArn(region?: string): string {
  const r = region?.startsWith('eu-') ? 'eu-central-1' : 'us-east-1'
  return `arn:aws:codewhisperer:${r}:${ENTERPRISE_FALLBACK_ACCOUNT_ID}:profile/${ENTERPRISE_FALLBACK_PROFILE_ID}`
}

const PLACEHOLDER_PROFILE_ARNS = new Set<string>([KIRO_BUILDER_ID_PLACEHOLDER_ARN])

export function isPlaceholderProfileArn(arn: string | undefined | null): boolean {
  if (!arn) return false
  return PLACEHOLDER_PROFILE_ARNS.has(arn)
}

export function resolveProfileArnForWrite(input: {
  profileArn?: string
  authMethod?: string
  provider?: string
  region?: string
}): string | undefined {
  if (input.profileArn && !isPlaceholderProfileArn(input.profileArn)) {
    return input.profileArn
  }
  if (input.authMethod === 'social' || input.provider === 'Github' || input.provider === 'Google') {
    return KIRO_SOCIAL_PROFILE_ARN
  }
  if (input.provider === 'Enterprise' || input.authMethod === 'external_idp') {
    return getEnterpriseFallbackArn(input.region)
  }
  return KIRO_BUILDER_ID_PLACEHOLDER_ARN
}

export interface KiroAuthTokenFile {
  accessToken: string
  refreshToken: string
  expiresAt: string
  authMethod?: 'IdC' | 'social' | string
  provider?: string
  region?: string
  clientIdHash?: string
  profileArn?: string
}

export interface WriteKiroAuthTokenInput {
  accessToken: string
  refreshToken: string
  expiresAtIso: string
  authMethod?: string
  provider?: string
  region?: string
  startUrl?: string
  clientId?: string
  clientSecret?: string
  clientIdHash?: string
  profileArn?: string
}

export interface WriteKiroAuthTokenResult {
  tokenPath: string
  clientRegPath?: string
}

export interface ClientRegistrationFile {
  clientId: string
  clientSecret: string
  expiresAt?: string
  scopes?: string[]
}

export function computeClientIdHash(startUrl: string = KIRO_DEFAULT_START_URL): string {
  return crypto
    .createHash('sha1')
    .update(JSON.stringify({ startUrl }))
    .digest('hex')
}

export async function writeKiroAuthTokenFile(input: WriteKiroAuthTokenInput): Promise<WriteKiroAuthTokenResult> {
  const isSocial = input.authMethod === 'social' || input.provider === 'Github' || input.provider === 'Google'
  const clientIdHash = input.clientIdHash || computeClientIdHash(input.startUrl || KIRO_DEFAULT_START_URL)
  const finalProfileArn = resolveProfileArnForWrite({
    profileArn: input.profileArn,
    authMethod: input.authMethod,
    provider: input.provider,
    region: input.region
  })

  const outObj: KiroAuthTokenFile = isSocial
    ? {
        accessToken: input.accessToken,
        refreshToken: input.refreshToken,
        profileArn: finalProfileArn,
        expiresAt: input.expiresAtIso,
        authMethod: 'social',
        provider: input.provider || 'Github'
      }
    : {
        accessToken: input.accessToken,
        refreshToken: input.refreshToken,
        expiresAt: input.expiresAtIso,
        clientIdHash,
        authMethod: 'IdC',
        provider: input.provider || 'BuilderId',
        region: input.region || 'us-east-1',
        profileArn: finalProfileArn
      }

  await fs.mkdir(KIRO_SSO_CACHE_DIR, { recursive: true })
  await fs.writeFile(KIRO_AUTH_TOKEN_PATH, JSON.stringify(outObj, null, 2), { mode: 0o600 })

  let clientRegPath: string | undefined
  if (!isSocial && input.clientId && input.clientSecret) {
    clientRegPath = path.join(KIRO_SSO_CACHE_DIR, `${clientIdHash}.json`)
    const clientExpiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000)
      .toISOString()
      .replace(/Z$/, '')
    const clientData: ClientRegistrationFile = {
      clientId: input.clientId,
      clientSecret: input.clientSecret,
      expiresAt: clientExpiresAt,
      scopes: KIRO_OIDC_SCOPES
    }
    await fs.writeFile(clientRegPath, JSON.stringify(clientData, null, 2), { mode: 0o600 })
  }

  return { tokenPath: KIRO_AUTH_TOKEN_PATH, clientRegPath }
}

export async function readKiroAuthTokenFile(): Promise<KiroAuthTokenFile | null> {
  try {
    const raw = await fs.readFile(KIRO_AUTH_TOKEN_PATH, 'utf-8')
    return JSON.parse(raw) as KiroAuthTokenFile
  } catch {
    return null
  }
}

export async function readClientRegistration(clientIdHash: string | undefined): Promise<ClientRegistrationFile | null> {
  if (!clientIdHash) return null

  try {
    const raw = await fs.readFile(path.join(KIRO_SSO_CACHE_DIR, `${clientIdHash}.json`), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<ClientRegistrationFile>
    if (!parsed.clientId || !parsed.clientSecret) return null
    return {
      clientId: parsed.clientId,
      clientSecret: parsed.clientSecret,
      expiresAt: parsed.expiresAt,
      scopes: parsed.scopes
    }
  } catch {
    return null
  }
}
