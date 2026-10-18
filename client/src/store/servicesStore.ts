import { create } from 'zustand'
import { servicesApi, type ServicesConfig } from '../api/services'

interface ServicesState {
  userId: number | null
  config: ServicesConfig | null
  isLoading: boolean
  isLoaded: boolean
  loadError: boolean
  load: (userId: number, force?: boolean) => Promise<void>
  setConfig: (config: ServicesConfig) => void
  clear: () => void
}

let requestId = 0
let inFlight: { userId: number; promise: Promise<void> } | null = null

export const useServicesStore = create<ServicesState>((set, get) => ({
  userId: null,
  config: null,
  isLoading: false,
  isLoaded: false,
  loadError: false,

  load: (userId, force = false) => {
    const state = get()
    if (!force && state.userId === userId && state.isLoaded) return Promise.resolve()
    if (!force && inFlight?.userId === userId) return inFlight.promise

    const currentRequest = ++requestId
    set({ userId, config: null, isLoading: true, isLoaded: false, loadError: false })
    const promise = servicesApi.getConfig()
      .then(config => {
        if (currentRequest === requestId) {
          set({ config, isLoading: false, isLoaded: true, loadError: false })
        }
      })
      .catch(() => {
        if (currentRequest === requestId) {
          set({ config: null, isLoading: false, isLoaded: false, loadError: true })
        }
      })
      .finally(() => {
        if (inFlight?.promise === promise) inFlight = null
      })
    inFlight = { userId, promise }
    return promise
  },

  setConfig: config => set({ config, isLoaded: true, isLoading: false, loadError: false }),

  clear: () => {
    ++requestId
    inFlight = null
    set({ userId: null, config: null, isLoading: false, isLoaded: false, loadError: false })
  },
}))
