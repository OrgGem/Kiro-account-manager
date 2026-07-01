import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { KIRO_SSO_CACHE_DIR } from './kiroAuthSync'

const CONFIG_PATH = path.join(KIRO_SSO_CACHE_DIR, 'kiro-session-config.json')

export interface SessionConfig {
  region?: string
  startUrl?: string
  proxyUrl?: string
  clientId?: string
  clientSecret?: string
}

export async function readConfig(): Promise<SessionConfig> {
  try {
    const raw = await fs.readFile(CONFIG_PATH, 'utf-8')
    return JSON.parse(raw) as SessionConfig
  } catch {
    return {
      region: 'us-east-1',
      startUrl: 'https://view.awsapps.com/start'
    }
  }
}

export async function writeConfig(config: SessionConfig): Promise<void> {
  const current = await readConfig()
  const merged = { ...current, ...config }
  await fs.mkdir(KIRO_SSO_CACHE_DIR, { recursive: true })
  await fs.writeFile(CONFIG_PATH, JSON.stringify(merged, null, 2), { mode: 0o600 })
}
