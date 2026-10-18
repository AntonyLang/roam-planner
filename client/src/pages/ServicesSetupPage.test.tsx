import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TranslationProvider } from '../i18n'
import { useSettingsStore } from '../store/settingsStore'
import { useServicesStore } from '../store/servicesStore'
import ServicesSetupPage from './ServicesSetupPage'

const api = vi.hoisted(() => ({
  getConfig: vi.fn(),
  updateConfig: vi.fn(),
  check: vi.fn(),
  complete: vi.fn(),
  skip: vi.fn(),
  xhsStatus: vi.fn(),
  startXhsLogin: vi.fn(),
  logoutXhs: vi.fn(),
}))

vi.mock('../api/services', () => ({ servicesApi: api }))

const config = (setupComplete = false) => ({
  setup_complete: setupComplete,
  needs_setup: true,
  model: { base_url: 'https://model.example/v1', model_id: 'travel-model', thinking_level: 'medium', api_key_configured: true },
  maps: { provider: 'amap' as const, amap_key_configured: false, geoapify_key_configured: false },
  search: { exa_mcp_url: '' },
  xhs: { enabled: false },
})

function renderPage() {
  return render(<MemoryRouter><TranslationProvider><ServicesSetupPage /></TranslationProvider></MemoryRouter>)
}

beforeEach(() => {
  vi.clearAllMocks()
  useSettingsStore.setState(state => ({ settings: { ...state.settings, language: 'en' } }))
  useServicesStore.setState({
    userId: 1,
    config: config(),
    isLoading: false,
    isLoaded: true,
    loadError: false,
  })
  api.xhsStatus.mockResolvedValue({ status: 'not_logged_in', message: '' })
  api.updateConfig.mockResolvedValue(config())
  api.check.mockResolvedValue({ ok: true, message: 'Connection ready', checked_at: '2026-10-18T00:00:00.000Z', latency_ms: 210 })
  api.complete.mockResolvedValue(config(true))
  api.skip.mockResolvedValue({ ...config(true), model: { ...config().model, api_key_configured: false } })
})

describe('ServicesSetupPage', () => {
  it('allows first-run setup to be skipped without a key or a connection check', async () => {
    renderPage()
    fireEvent.click(screen.getAllByRole('button', { name: 'Set up later and use trip management' })[0])
    await waitFor(() => expect(api.skip).toHaveBeenCalledOnce())
    expect(api.complete).not.toHaveBeenCalled()
    expect(api.check).not.toHaveBeenCalled()
    expect(useServicesStore.getState().config?.setup_complete).toBe(true)
    expect(useServicesStore.getState().config?.model.api_key_configured).toBe(false)
  })
  it('saves a newly entered key, never echoes it into storage, then requires a successful check before completion', async () => {
    renderPage()

    const keyInput = screen.getByLabelText('API key') as HTMLInputElement
    expect(keyInput.type).toBe('password')
    expect(keyInput.value).toBe('')
    expect(screen.getByRole('button', { name: 'Skip optional services and continue' })).toBeDisabled()

    fireEvent.change(keyInput, { target: { value: 'private-model-key' } })
    fireEvent.click(screen.getAllByRole('button', { name: 'Save settings' })[0])

    await waitFor(() => expect(api.updateConfig).toHaveBeenCalledWith({
      model: {
        base_url: 'https://model.example/v1',
        model_id: 'travel-model',
        thinking_level: 'medium',
        api_key: 'private-model-key',
      },
    }))
    expect(keyInput.value).toBe('')
    expect(JSON.stringify(Array.from({ length: localStorage.length }, (_, index) => localStorage.getItem(localStorage.key(index) ?? '')))).not.toContain('private-model-key')
    expect(screen.getByRole('button', { name: 'Skip optional services and continue' })).toBeDisabled()

    fireEvent.click(screen.getAllByRole('button', { name: 'Check connection' })[0])
    await screen.findByText('Connection ready')
    expect(screen.getByRole('button', { name: 'Skip optional services and continue' })).toBeEnabled()

    fireEvent.click(screen.getByRole('button', { name: 'Skip optional services and continue' }))
    await waitFor(() => expect(api.complete).toHaveBeenCalledOnce())
  })

  it('requires Xiaohongshu to be enabled and saved before starting QR login', async () => {
    api.updateConfig.mockResolvedValue({ ...config(), xhs: { enabled: true } })
    api.startXhsLogin.mockResolvedValue({ status: 'waiting_scan', message: 'Scan the code', qr_image: 'data:image/png;base64,AA==' })
    renderPage()

    const login = screen.getByRole('button', { name: 'Start QR login' })
    expect(login).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox', { name: /Enable Xiaohongshu/ }))
    expect(login).toBeDisabled()

    fireEvent.click(screen.getAllByRole('button', { name: 'Save settings' })[3])
    await waitFor(() => expect(api.updateConfig).toHaveBeenCalledWith({ xhs: { enabled: true } }))
    expect(screen.getByRole('button', { name: 'Start QR login' })).toBeEnabled()

    fireEvent.click(screen.getByRole('button', { name: 'Start QR login' }))
    await waitFor(() => expect(api.startXhsLogin).toHaveBeenCalledOnce())
    expect(await screen.findByAltText('Xiaohongshu login QR code')).toBeInTheDocument()
  })
})
