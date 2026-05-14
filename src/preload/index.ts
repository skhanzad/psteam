import { contextBridge, ipcRenderer } from 'electron'

type TrophyTier = 'gold' | 'silver' | 'bronze' | 'platinum'

type TrophyUnlockPayload = {
  displayName: string
  tier: TrophyTier
  description: string
  iconUrl?: string
}

/** Set on the overlay BrowserWindow via webPreferences.additionalArguments */
const isOverlayWindow = process.argv.includes('--psteam-overlay')

const api = {
  isOverlayWindow,
  storeGet: <K extends string>(key: K) => ipcRenderer.invoke('store:get', key),
  storeSet: (key: string, value: unknown) => ipcRenderer.invoke('store:set', key, value),
  achievementsRefresh: () => ipcRenderer.invoke('achievements:refresh'),
  overlayClose: () => ipcRenderer.invoke('overlay:close'),
  overlayBumpZOrder: () => ipcRenderer.invoke('overlay:bump-z-order'),
  openSettings: () => ipcRenderer.invoke('app:open-settings'),
  overlaySetCompact: (compact: boolean) => ipcRenderer.invoke('overlay:set-compact', compact),
  onOverlayCompact: (cb: (compact: boolean) => void) => {
    const fn = (_e: Electron.IpcRendererEvent, v: boolean) => cb(v)
    ipcRenderer.on('overlay:compact-changed', fn)
    return () => ipcRenderer.removeListener('overlay:compact-changed', fn)
  },
  onTrophyUnlock: (cb: (p: TrophyUnlockPayload) => void) => {
    const fn = (_e: Electron.IpcRendererEvent, payload: TrophyUnlockPayload) => cb(payload)
    ipcRenderer.on('trophy-unlock', fn)
    return () => ipcRenderer.removeListener('trophy-unlock', fn)
  },
  onAchievementsUpdated: (cb: () => void) => {
    const fn = () => cb()
    ipcRenderer.on('achievements:updated', fn)
    return () => ipcRenderer.removeListener('achievements:updated', fn)
  }
}

contextBridge.exposeInMainWorld('psteam', api)
