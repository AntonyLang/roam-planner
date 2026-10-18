import React, { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, ArrowRight, Check, AlertCircle as CircleAlert, Loader2 as LoaderCircle, MapPinned, Search, Sparkles, Store, X } from 'lucide-react'
import { Link, useNavigate } from 'react-router'
import PageShell from '../components/Layout/PageShell'
import { useTranslation } from '../i18n'
import { servicesApi, type ServiceCheckName, type ServiceCheckResult, type ServicesConfig, type ServicesConfigUpdate, type XhsLoginStatus } from '../api/services'
import { useServicesStore } from '../store/servicesStore'
import { getApiErrorMessage } from '../utils/apiError'

type ServiceVersions = Record<ServiceCheckName, number>
type ServiceChecks = Partial<Record<ServiceCheckName, { result: ServiceCheckResult; version: number }>>
type ServiceErrors = Partial<Record<ServiceCheckName, string>>

const EMPTY_VERSIONS: ServiceVersions = { model: 0, maps: 0, search: 0, xhs: 0 }
const ACTIVE_XHS_STATES = new Set<XhsLoginStatus['status']>(['starting', 'waiting_scan', 'requires_verification'])

function serviceSettings(config: ServicesConfig | null): ServicesConfig {
  return config ?? {
    setup_complete: false,
    needs_setup: true,
    model: { base_url: '', model_id: '', thinking_level: 'medium', api_key_configured: false },
    maps: { provider: 'amap', amap_key_configured: false, geoapify_key_configured: false },
    search: { exa_mcp_url: '' },
    xhs: { enabled: false },
  }
}

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-content-secondary">{label}</label>
      {children}
      {hint && <p className="mt-1.5 text-xs leading-5 text-content-faint">{hint}</p>}
    </div>
  )
}

function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`w-full rounded-lg border border-edge bg-surface-secondary px-3 py-2.5 text-sm text-content placeholder:text-content-faint focus:outline-none focus:ring-2 focus:ring-slate-400 ${props.className ?? ''}`} />
}

export default function ServicesSetupPage(): React.ReactElement {
  const { t, locale } = useTranslation()
  const navigate = useNavigate()
  const config = useServicesStore(s => s.config)
  const setConfig = useServicesStore(s => s.setConfig)
  const current = useMemo(() => serviceSettings(config), [config])
  const onboarding = !current.setup_complete

  const [model, setModel] = useState(() => ({
    base_url: current.model.base_url,
    model_id: current.model.model_id,
    thinking_level: current.model.thinking_level || 'medium',
  }))
  const [modelKey, setModelKey] = useState('')
  const [clearModelKey, setClearModelKey] = useState(false)
  const [mapProvider, setMapProvider] = useState<'amap' | 'geoapify'>(current.maps.provider)
  const [mapKeys, setMapKeys] = useState({ amap: '', geoapify: '' })
  const [clearMapKey, setClearMapKey] = useState({ amap: false, geoapify: false })
  const [searchUrl, setSearchUrl] = useState(current.search.exa_mcp_url)
  const [xhsEnabled, setXhsEnabled] = useState(current.xhs.enabled)
  const [versions, setVersions] = useState<ServiceVersions>(EMPTY_VERSIONS)
  const [savedVersions, setSavedVersions] = useState<ServiceVersions>(EMPTY_VERSIONS)
  const [checks, setChecks] = useState<ServiceChecks>({})
  const [errors, setErrors] = useState<ServiceErrors>({})
  const [saving, setSaving] = useState<ServiceCheckName | null>(null)
  const [checking, setChecking] = useState<ServiceCheckName | null>(null)
  const [completing, setCompleting] = useState(false)
  const [completeError, setCompleteError] = useState('')
  const [xhsStatus, setXhsStatus] = useState<XhsLoginStatus | null>(null)
  const [xhsStatusLoading, setXhsStatusLoading] = useState(true)
  const [xhsActionBusy, setXhsActionBusy] = useState(false)
  const [xhsActionError, setXhsActionError] = useState('')
  const [xhsPollError, setXhsPollError] = useState('')

  useEffect(() => {
    let cancelled = false
    servicesApi.xhsStatus()
      .then(status => { if (!cancelled) setXhsStatus(status) })
      .catch(() => { if (!cancelled) setXhsPollError(t('services.xhs.statusError')) })
      .finally(() => { if (!cancelled) setXhsStatusLoading(false) })
    return () => { cancelled = true }
  }, [t])

  useEffect(() => {
    if (!xhsStatus || !ACTIVE_XHS_STATES.has(xhsStatus.status)) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const status = await servicesApi.xhsStatus()
        if (cancelled) return
        setXhsStatus(status)
        setXhsPollError('')
        if (ACTIVE_XHS_STATES.has(status.status)) timer = setTimeout(poll, 3000)
      } catch {
        if (!cancelled) {
          setXhsPollError(t('services.xhs.statusError'))
          timer = setTimeout(poll, 3000)
        }
      }
    }
    timer = setTimeout(poll, 3000)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [xhsStatus?.status, t])

  const bump = (service: ServiceCheckName) => {
    setVersions(currentVersions => ({ ...currentVersions, [service]: currentVersions[service] + 1 }))
    setErrors(currentErrors => ({ ...currentErrors, [service]: '' }))
  }
  const modelUpdate = (): ServicesConfigUpdate => ({
    model: {
      base_url: model.base_url.trim(),
      model_id: model.model_id.trim(),
      thinking_level: model.thinking_level.trim(),
      ...(clearModelKey ? { api_key: null } : modelKey.trim() ? { api_key: modelKey.trim() } : {}),
    },
  })
  const mapUpdate = (): ServicesConfigUpdate => {
    const maps: NonNullable<ServicesConfigUpdate['maps']> = { provider: mapProvider }
    const keyField = mapProvider === 'amap' ? 'amap_key' : 'geoapify_key'
    if (clearMapKey[mapProvider]) maps[keyField] = null
    else if (mapKeys[mapProvider].trim()) maps[keyField] = mapKeys[mapProvider].trim()
    return { maps }
  }
  const searchUpdate = (): ServicesConfigUpdate => ({ search: { exa_mcp_url: searchUrl.trim() } })
  const xhsUpdate = (): ServicesConfigUpdate => ({ xhs: { enabled: xhsEnabled } })

  const update = (service: ServiceCheckName): ServicesConfigUpdate => {
    if (service === 'model') return modelUpdate()
    if (service === 'maps') return mapUpdate()
    if (service === 'search') return searchUpdate()
    return xhsUpdate()
  }
  const saved = (service: ServiceCheckName) => savedVersions[service] === versions[service]
  const checked = (service: ServiceCheckName) => checks[service]?.version === versions[service]
  const modelReady = model.base_url.trim().length > 0 && model.model_id.trim().length > 0
  const modelCanComplete = saved('model') && checked('model') && checks.model?.result.ok === true
  const xhsLoginReady = xhsEnabled && saved('xhs') && current.xhs.enabled

  const save = async (service: ServiceCheckName) => {
    if (saving || checking) return
    if (service === 'model' && !modelReady) {
      setErrors(currentErrors => ({ ...currentErrors, model: t('services.model.requiredFields') }))
      return
    }
    setSaving(service)
    setErrors(currentErrors => ({ ...currentErrors, [service]: '' }))
    try {
      const next = await servicesApi.updateConfig(update(service))
      setConfig(next)
      setSavedVersions(currentVersions => ({ ...currentVersions, [service]: versions[service] }))
      if (service === 'model') { setModelKey(''); setClearModelKey(false) }
      if (service === 'maps') {
        setMapKeys(currentKeys => ({ ...currentKeys, [mapProvider]: '' }))
        setClearMapKey(currentClear => ({ ...currentClear, [mapProvider]: false }))
      }
    } catch (error) {
      setErrors(currentErrors => ({ ...currentErrors, [service]: getApiErrorMessage(error, t('services.saveError')) }))
    } finally {
      setSaving(null)
    }
  }

  const check = async (service: ServiceCheckName) => {
    if (saving || checking) return
    if (service === 'model' && !modelReady) {
      setErrors(currentErrors => ({ ...currentErrors, model: t('services.model.requiredFields') }))
      return
    }
    setChecking(service)
    setErrors(currentErrors => ({ ...currentErrors, [service]: '' }))
    setChecks(currentChecks => ({ ...currentChecks, [service]: undefined }))
    try {
      const result = await servicesApi.check(service, update(service))
      setChecks(currentChecks => ({ ...currentChecks, [service]: { result, version: versions[service] } }))
    } catch (error) {
      setErrors(currentErrors => ({ ...currentErrors, [service]: getApiErrorMessage(error, t('services.checkError')) }))
    } finally {
      setChecking(null)
    }
  }

  const complete = async (skip = false) => {
    if ((!skip && !modelCanComplete) || completing) return
    setCompleting(true)
    setCompleteError('')
    try {
      const next = await (skip ? servicesApi.skip() : servicesApi.complete())
      setConfig(next)
      if (next.setup_complete) navigate('/dashboard', { replace: true })
      else setCompleteError(t('services.completeError'))
    } catch (error) {
      setCompleteError(getApiErrorMessage(error, t('services.completeError')))
    } finally {
      setCompleting(false)
    }
  }

  const startXhsLogin = async () => {
    setXhsActionBusy(true)
    setXhsActionError('')
    setXhsPollError('')
    try {
      setXhsStatus(await servicesApi.startXhsLogin())
      setXhsStatusLoading(false)
    } catch (error) {
      setXhsActionError(getApiErrorMessage(error, t('services.xhs.loginError')))
    } finally {
      setXhsActionBusy(false)
    }
  }

  const logoutXhs = async () => {
    setXhsActionBusy(true)
    setXhsActionError('')
    try {
      setXhsStatus(await servicesApi.logoutXhs())
    } catch (error) {
      setXhsActionError(getApiErrorMessage(error, t('services.xhs.logoutError')))
    } finally {
      setXhsActionBusy(false)
    }
  }

  const checkStatus = (service: ServiceCheckName): React.ReactNode => {
    if (checking === service) {
      return <p className="mt-3 flex items-center gap-2 text-sm text-content-secondary" role="status"><LoaderCircle size={15} className="animate-spin" />{t('services.checking')}</p>
    }
    const result = checks[service]
    if (result && result.version !== versions[service]) {
      return <p className="mt-3 text-sm text-content-faint">{t('services.checkStale')}</p>
    }
    if (!result) return null
    const checkedAt = new Date(result.result.checked_at)
    const checkedTime = Number.isNaN(checkedAt.getTime()) ? '' : new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' }).format(checkedAt)
    return (
      <div className={`mt-3 rounded-lg border px-3 py-2.5 text-sm ${result.result.ok ? 'border-emerald-500/25 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300' : 'border-red-500/25 bg-red-500/5 text-red-700 dark:text-red-300'}`} role={result.result.ok ? 'status' : 'alert'}>
        <div className="flex items-start gap-2"><span className="mt-0.5">{result.result.ok ? <Check size={15} /> : <CircleAlert size={15} />}</span><span>{result.result.message}</span></div>
        <p className="mt-1 pl-[23px] text-xs opacity-75">{t('services.checkMeta', { latency: result.result.latency_ms, time: checkedTime })}</p>
      </div>
    )
  }

  const saveBadge = (service: ServiceCheckName) => {
    const configured = service === 'model' ? !current.needs_setup
      : service === 'maps' ? (mapProvider === 'amap' ? current.maps.amap_key_configured : current.maps.geoapify_key_configured)
      : service === 'search' ? !!current.search.exa_mcp_url.trim()
      : current.xhs.enabled
    const label = !saved(service) ? t('services.unsaved')
      : service === 'xhs' ? (configured ? t('services.enabled') : t('services.disabled'))
      : (configured ? t('services.configured') : t('services.notConfigured'))
    return <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${!saved(service) ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300' : configured ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'bg-surface-tertiary text-content-faint'}`}>{label}</span>
  }

  const actionButtons = (service: ServiceCheckName, canCheck = true) => (
    <div className="mt-4 flex flex-wrap gap-2">
      <button type="button" onClick={() => void save(service)} disabled={!!saving || !!checking || (service === 'model' && !modelReady)} className="rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white dark:text-slate-950 dark:hover:bg-slate-200">
        {saving === service ? <span className="inline-flex items-center gap-2"><LoaderCircle size={15} className="animate-spin" />{t('services.saving')}</span> : t('services.save')}
      </button>
      {canCheck && <button type="button" onClick={() => void check(service)} disabled={!!saving || !!checking || (service === 'model' && !modelReady)} className="rounded-lg border border-edge bg-surface-secondary px-4 py-2.5 text-sm font-semibold text-content-secondary hover:bg-surface-tertiary disabled:cursor-not-allowed disabled:opacity-50">
        {checking === service ? <span className="inline-flex items-center gap-2"><LoaderCircle size={15} className="animate-spin" />{t('services.checking')}</span> : t('services.checkConnection')}
      </button>}
    </div>
  )

  return (
    <PageShell background="var(--bg-secondary)">
      <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
        {!onboarding && <Link to="/dashboard" className="mb-6 inline-flex items-center gap-2 text-sm font-medium text-content-muted hover:text-content">
          <ArrowLeft size={16} />{t('services.backToHome')}
        </Link>}
        <header className="mb-6 flex items-start gap-3">
          <div className="flex h-11 w-11 flex-none items-center justify-center rounded-xl bg-surface-tertiary text-content-secondary"><Sparkles size={21} /></div>
          <div>
            <h1 className="text-2xl font-bold text-content">{onboarding ? t('services.onboarding.title') : t('services.title')}</h1>
            <p className="mt-1 text-sm leading-6 text-content-muted">{onboarding ? t('services.onboarding.subtitle') : t('services.subtitle')}</p>
          </div>
        </header>

        {onboarding && <div className="mb-5 rounded-xl border border-sky-500/20 bg-sky-500/5 px-4 py-3 text-sm leading-6 text-content-secondary"><p>{t('services.onboarding.hint')}</p><button type="button" onClick={() => void complete(true)} disabled={completing || !!saving || !!checking} className="mt-2 font-medium underline underline-offset-4 disabled:opacity-50">{t('services.skipForNow')}</button></div>}

        <div className="space-y-4">
          <section className="rounded-2xl border border-edge bg-surface-card p-5 shadow-sm sm:p-6">
            <div className="mb-4 flex items-start justify-between gap-3">
              <div className="flex items-start gap-3"><span className="mt-0.5 text-content-secondary"><Sparkles size={19} /></span><div><h2 className="font-semibold text-content">{t('services.model.title')} <span className="text-xs font-medium text-red-600 dark:text-red-400">{t('services.required')}</span></h2><p className="mt-1 text-sm leading-5 text-content-muted">{t('services.model.description')}</p></div></div>
              {saveBadge('model')}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id="services-model-url" label={t('services.model.baseUrl')}>
                <TextInput id="services-model-url" type="url" autoComplete="url" value={model.base_url} onChange={e => { setModel(value => ({ ...value, base_url: e.target.value })); bump('model') }} placeholder="https://…" />
              </Field>
              <Field id="services-model-id" label={t('services.model.modelId')}>
                <TextInput id="services-model-id" type="text" autoComplete="off" value={model.model_id} onChange={e => { setModel(value => ({ ...value, model_id: e.target.value })); bump('model') }} placeholder={t('services.model.modelPlaceholder')} />
              </Field>
              <Field id="services-model-thinking" label={t('services.model.thinkingLevel')}>
                <select id="services-model-thinking" value={model.thinking_level} onChange={e => { setModel(value => ({ ...value, thinking_level: e.target.value })); bump('model') }} className="w-full rounded-lg border border-edge bg-surface-secondary px-3 py-2.5 text-sm text-content focus:outline-none focus:ring-2 focus:ring-slate-400">
                  <option value="low">{t('services.model.thinking.low')}</option>
                  <option value="medium">{t('services.model.thinking.medium')}</option>
                  <option value="high">{t('services.model.thinking.high')}</option>
                </select>
              </Field>
              <Field id="services-model-key" label={t('services.model.apiKey')} hint={current.model.api_key_configured ? t('services.keyConfiguredHint') : t('services.model.apiKeyHint')}>
                <TextInput id="services-model-key" type="password" autoComplete="new-password" value={modelKey} onChange={e => { setModelKey(e.target.value); setClearModelKey(false); bump('model') }} placeholder={current.model.api_key_configured ? t('services.keyReplacePlaceholder') : t('services.model.apiKeyPlaceholder')} />
                {current.model.api_key_configured && <button type="button" onClick={() => { setModelKey(''); setClearModelKey(true); bump('model') }} className="mt-1.5 inline-flex items-center gap-1 text-xs text-red-600 hover:underline dark:text-red-400"><X size={13} />{t('services.clearKey')}</button>}
              </Field>
            </div>
            {errors.model && <p className="mt-3 text-sm text-red-600 dark:text-red-400" role="alert">{errors.model}</p>}
            {modelReady && !current.model.api_key_configured && !modelKey.trim() && <p className="mt-3 text-xs text-content-faint">{t('services.model.keyMayBeOptional')}</p>}
            {actionButtons('model')}
            {checkStatus('model')}
          </section>

          <section className="rounded-2xl border border-edge bg-surface-card p-5 shadow-sm sm:p-6">
            <div className="mb-4 flex items-start justify-between gap-3">
              <div className="flex items-start gap-3"><span className="mt-0.5 text-content-secondary"><MapPinned size={19} /></span><div><h2 className="font-semibold text-content">{t('services.maps.title')} <span className="text-xs font-medium text-content-faint">{t('services.optional')}</span></h2><p className="mt-1 text-sm leading-5 text-content-muted">{t('services.maps.description')}</p></div></div>
              {saveBadge('maps')}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id="services-maps-provider" label={t('services.maps.provider')}>
                <select id="services-maps-provider" value={mapProvider} onChange={e => { setMapProvider(e.target.value as 'amap' | 'geoapify'); bump('maps') }} className="w-full rounded-lg border border-edge bg-surface-secondary px-3 py-2.5 text-sm text-content focus:outline-none focus:ring-2 focus:ring-slate-400">
                  <option value="amap">{t('services.maps.amap')}</option>
                  <option value="geoapify">{t('services.maps.geoapify')}</option>
                </select>
              </Field>
              <Field id="services-maps-key" label={mapProvider === 'amap' ? t('services.maps.amapKey') : t('services.maps.geoapifyKey')} hint={(mapProvider === 'amap' ? current.maps.amap_key_configured : current.maps.geoapify_key_configured) ? t('services.keyConfiguredHint') : t('services.maps.keyHint')}>
                <TextInput id="services-maps-key" type="password" autoComplete="new-password" value={mapKeys[mapProvider]} onChange={e => { setMapKeys(value => ({ ...value, [mapProvider]: e.target.value })); setClearMapKey(value => ({ ...value, [mapProvider]: false })); bump('maps') }} placeholder={(mapProvider === 'amap' ? current.maps.amap_key_configured : current.maps.geoapify_key_configured) ? t('services.keyReplacePlaceholder') : t('services.maps.keyPlaceholder')} />
                {(mapProvider === 'amap' ? current.maps.amap_key_configured : current.maps.geoapify_key_configured) && <button type="button" onClick={() => { setMapKeys(value => ({ ...value, [mapProvider]: '' })); setClearMapKey(value => ({ ...value, [mapProvider]: true })); bump('maps') }} className="mt-1.5 inline-flex items-center gap-1 text-xs text-red-600 hover:underline dark:text-red-400"><X size={13} />{t('services.clearKey')}</button>}
              </Field>
            </div>
            {errors.maps && <p className="mt-3 text-sm text-red-600 dark:text-red-400" role="alert">{errors.maps}</p>}
            {actionButtons('maps')}
            {checkStatus('maps')}
          </section>

          <section className="rounded-2xl border border-edge bg-surface-card p-5 shadow-sm sm:p-6">
            <div className="mb-4 flex items-start justify-between gap-3">
              <div className="flex items-start gap-3"><span className="mt-0.5 text-content-secondary"><Search size={19} /></span><div><h2 className="font-semibold text-content">{t('services.search.title')} <span className="text-xs font-medium text-content-faint">{t('services.optional')}</span></h2><p className="mt-1 text-sm leading-5 text-content-muted">{t('services.search.description')}</p></div></div>
              {saveBadge('search')}
            </div>
            <Field id="services-search-url" label={t('services.search.url')} hint={t('services.search.hint')}>
              <TextInput id="services-search-url" type="url" autoComplete="url" value={searchUrl} onChange={e => { setSearchUrl(e.target.value); bump('search') }} placeholder="https://…" />
            </Field>
            {errors.search && <p className="mt-3 text-sm text-red-600 dark:text-red-400" role="alert">{errors.search}</p>}
            {actionButtons('search')}
            {checkStatus('search')}
          </section>

          <section className="rounded-2xl border border-edge bg-surface-card p-5 shadow-sm sm:p-6">
            <div className="mb-4 flex items-start justify-between gap-3">
              <div className="flex items-start gap-3"><span className="mt-0.5 text-content-secondary"><Store size={19} /></span><div><h2 className="font-semibold text-content">{t('services.xhs.title')} <span className="text-xs font-medium text-content-faint">{t('services.optional')}</span></h2><p className="mt-1 text-sm leading-5 text-content-muted">{t('services.xhs.description')}</p></div></div>
              {saveBadge('xhs')}
            </div>
            <label className="flex items-start gap-3 rounded-xl border border-edge-secondary bg-surface-secondary p-3 text-sm text-content-secondary">
              <input type="checkbox" checked={xhsEnabled} onChange={e => { setXhsEnabled(e.target.checked); bump('xhs') }} className="mt-0.5 accent-slate-900" />
              <span><strong className="font-medium text-content">{t('services.xhs.enable')}</strong><span className="mt-0.5 block text-xs leading-5 text-content-faint">{t('services.xhs.enableHint')}</span></span>
            </label>
            <div className="mt-4 rounded-xl border border-edge-secondary bg-surface-secondary p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-content">{t('services.xhs.loginStatus')}</p>
                  <p className="mt-1 text-sm text-content-secondary" role="status">{xhsStatusLoading ? t('services.loading') : xhsStatus ? t(`services.xhs.status.${xhsStatus.status}`) : t('services.xhs.statusUnavailable')}</p>
                  {xhsStatus?.message && <p className="mt-1 text-xs leading-5 text-content-faint">{xhsStatus.message}</p>}
                </div>
                <div className="flex gap-2">
                  <button type="button" onClick={() => void startXhsLogin()} disabled={xhsActionBusy || !xhsLoginReady} className="rounded-lg border border-edge bg-surface-card px-3 py-2 text-sm font-medium text-content-secondary hover:bg-surface-tertiary disabled:opacity-50">{xhsActionBusy ? t('services.xhs.working') : t('services.xhs.login')}</button>
                  {xhsStatus?.status === 'logged_in' && <button type="button" onClick={() => void logoutXhs()} disabled={xhsActionBusy} className="rounded-lg border border-edge bg-surface-card px-3 py-2 text-sm font-medium text-content-secondary hover:bg-surface-tertiary disabled:opacity-50">{t('services.xhs.logout')}</button>}
                </div>
              </div>
              {!xhsLoginReady && <p className="mt-3 text-xs leading-5 text-content-faint">{t('services.xhs.enableBeforeLogin')}</p>}
              {xhsStatus?.qr_image?.startsWith('data:image/') && <div className="mt-4 flex flex-col items-center gap-2 rounded-lg border border-edge bg-white p-3"><img src={xhsStatus.qr_image} alt={t('services.xhs.qrAlt')} className="h-52 w-52 object-contain" /><p className="text-center text-xs text-slate-600">{t('services.xhs.scanHint')}</p></div>}
              {xhsPollError && <p className="mt-2 text-xs text-amber-700 dark:text-amber-300" role="status">{xhsPollError}</p>}
              {xhsActionError && <p className="mt-2 text-xs text-red-600 dark:text-red-400" role="alert">{xhsActionError}</p>}
            </div>
            {errors.xhs && <p className="mt-3 text-sm text-red-600 dark:text-red-400" role="alert">{errors.xhs}</p>}
            {actionButtons('xhs')}
            {checkStatus('xhs')}
          </section>
        </div>

        {onboarding && <footer className="mt-5 rounded-2xl border border-edge bg-surface-card p-5 shadow-sm sm:p-6">
          <p className="text-sm leading-6 text-content-secondary">{t('services.optionalCanSkip')}</p>
          <button type="button" onClick={() => void complete()} disabled={!modelCanComplete || completing} className="mt-4 inline-flex items-center gap-2 rounded-lg bg-slate-900 px-5 py-3 text-sm font-semibold text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white dark:text-slate-950 dark:hover:bg-slate-200">
            {completing ? <><LoaderCircle size={16} className="animate-spin" />{t('services.completing')}</> : <>{t('services.finish')}<ArrowRight size={15} /></>}
          </button>
          {!modelCanComplete && <p className="mt-2 text-xs text-content-faint" role="status">{t('services.finishHint')}</p>}
          <button type="button" onClick={() => void complete(true)} disabled={completing || !!saving || !!checking} className="mt-3 block rounded-lg px-1 py-2 text-sm font-medium text-content-muted underline underline-offset-4 hover:text-content disabled:opacity-50">{t('services.skipForNow')}</button>
          {completeError && <p className="mt-3 text-sm text-red-600 dark:text-red-400" role="alert">{completeError}</p>}
        </footer>}

        {!onboarding && <div className="mt-5 flex justify-end"><button type="button" onClick={() => navigate('/dashboard')} className="rounded-lg border border-edge bg-surface-card px-4 py-2.5 text-sm font-medium text-content-secondary hover:bg-surface-tertiary">{t('services.backToHome')}</button></div>}
      </div>
    </PageShell>
  )
}
