import { apiClient } from './client'

export interface ServicesConfig {
  setup_complete: boolean
  needs_setup: boolean
  model: {
    base_url: string
    model_id: string
    thinking_level: string
    api_key_configured: boolean
  }
  maps: {
    provider: 'amap' | 'geoapify'
    amap_key_configured: boolean
    geoapify_key_configured: boolean
  }
  search: { exa_mcp_url: string }
  xhs: { enabled: boolean }
}

export interface ModelServicesUpdate {
  base_url?: string
  model_id?: string
  thinking_level?: string
  api_key?: string | null
}

export interface MapsServicesUpdate {
  provider?: 'amap' | 'geoapify'
  amap_key?: string | null
  geoapify_key?: string | null
}

export interface ServicesConfigUpdate {
  model?: ModelServicesUpdate
  maps?: MapsServicesUpdate
  search?: { exa_mcp_url?: string }
  xhs?: { enabled?: boolean }
}

export type ServiceCheckName = 'model' | 'maps' | 'search' | 'xhs'

export interface ServiceCheckResult {
  ok: boolean
  message: string
  checked_at: string
  latency_ms: number
}

export type XhsLoginStatusName =
  | 'not_logged_in'
  | 'starting'
  | 'waiting_scan'
  | 'logged_in'
  | 'requires_verification'
  | 'expired'
  | 'error'

export interface XhsLoginStatus {
  status: XhsLoginStatusName
  message: string
  qr_image?: string
}

export const servicesApi = {
  getConfig: (): Promise<ServicesConfig> =>
    apiClient.get('/services/config').then(r => r.data),
  updateConfig: (config: ServicesConfigUpdate): Promise<ServicesConfig> =>
    apiClient.put('/services/config', config).then(r => r.data),
  check: (service: ServiceCheckName, config?: ServicesConfigUpdate): Promise<ServiceCheckResult> =>
    apiClient.post('/services/check', { service, config }, { timeout: 45_000 }).then(r => r.data),
  complete: (): Promise<ServicesConfig> =>
    apiClient.post('/services/complete').then(r => r.data),
  skip: (): Promise<ServicesConfig> =>
    apiClient.post('/services/skip').then(r => r.data),
  xhsStatus: (): Promise<XhsLoginStatus> =>
    apiClient.get('/services/xhs/status').then(r => r.data),
  startXhsLogin: (): Promise<XhsLoginStatus> =>
    apiClient.post('/services/xhs/login').then(r => r.data),
  logoutXhs: (): Promise<XhsLoginStatus> =>
    apiClient.post('/services/xhs/logout').then(r => r.data),
}
