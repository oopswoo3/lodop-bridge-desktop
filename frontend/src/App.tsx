import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import FloatingNoticeHost from './components/FloatingNoticeHost'
import type { NoticeItem, ShowNoticeFn } from './components/FloatingNoticeHost'
import QuickConnect from './components/QuickConnect'
import HostDiscovery from './components/HostDiscovery'

interface HostInfo {
  ip: string
  port: number
  hostname?: string
  os?: string
  version?: string
  rtt?: number
  timestamp: number
}

interface StatusResponse {
  boundHost: HostInfo | null
  status: {
    online: boolean
    error?: string | null
    phase?: string
    lastSuccessAt?: number | null
  }
}

interface DiscoveryHost {
  ip: string
  port: number
  hostname?: string
  os?: string
  version?: string
  rtt?: number
  tcpOk?: boolean
  scriptOk?: boolean
  status: 'online' | 'offline' | 'stale' | string
  source: string
  lastSeen: number
  lastOk?: number | null
}

interface FavoriteHost {
  ip: string
  port: number
  name: string
  updatedAt: number
}

interface FavoriteHostView extends FavoriteHost {
  status: 'online' | 'offline' | 'stale' | 'unknown' | string
  lastSeen?: number
  lastOk?: number | null
  rtt?: number
}

interface RefreshDiscoveryResponse {
  mode: string
  started: boolean
  skipped: boolean
  cooldownRemainingMs?: number | null
  hosts: DiscoveryHost[]
}

const QUICK_HEARTBEAT_INTERVAL_SECONDS = 15

function App() {
  const [status, setStatus] = useState<StatusResponse | null>(null)
  const [discoveryHosts, setDiscoveryHosts] = useState<DiscoveryHost[]>([])
  const [favoriteHosts, setFavoriteHosts] = useState<FavoriteHost[]>([])
  const [notices, setNotices] = useState<NoticeItem[]>([])
  const [scannerOpen, setScannerOpen] = useState(false)
  const [quickHeartbeatCountdownSec, setQuickHeartbeatCountdownSec] = useState(QUICK_HEARTBEAT_INTERVAL_SECONDS)
  const [draftTarget, setDraftTarget] = useState<{ ip: string; port: string }>({
    ip: '',
    port: '8000',
  })
  const lastBoundOfflineTriggerRef = useRef<string | null>(null)
  const noticeIdRef = useRef(1)
  const noticeTimersRef = useRef<Map<number, number>>(new Map())
  const discoveryByKey = useMemo(() => {
    const map = new Map<string, DiscoveryHost>()
    discoveryHosts.forEach((host) => {
      map.set(`${host.ip}:${host.port}`, host)
    })
    return map
  }, [discoveryHosts])
  const favoriteListView = useMemo<FavoriteHostView[]>(
    () =>
      favoriteHosts.map((host) => {
        const discovery = discoveryByKey.get(`${host.ip}:${host.port}`)
        return {
          ...host,
          status: discovery?.status ?? 'unknown',
          lastSeen: discovery?.lastSeen,
          lastOk: discovery?.lastOk,
          rtt: discovery?.rtt,
        }
      }),
    [favoriteHosts, discoveryByKey]
  )

  const loadStatus = useCallback(async () => {
    try {
      const result = await invoke<StatusResponse>('get_status')
      setStatus(result)
    } catch (error) {
      console.error('Failed to get status:', error)
    }
  }, [])

  const loadDiscoveryHosts = useCallback(async () => {
    try {
      const result = await invoke<DiscoveryHost[]>('get_discovery_hosts')
      setDiscoveryHosts(result || [])
    } catch (error) {
      console.error('Failed to get discovery hosts:', error)
    }
  }, [])

  const loadFavoriteHosts = useCallback(async () => {
    try {
      const result = await invoke<FavoriteHost[]>('get_favorite_hosts')
      setFavoriteHosts(result || [])
    } catch (error) {
      console.error('Failed to get favorite hosts:', error)
    }
  }, [])

  const refreshDiscovery = useCallback(
    async (mode: 'quick' | 'deep', reason: string) => {
      if (mode === 'quick') {
        setQuickHeartbeatCountdownSec(QUICK_HEARTBEAT_INTERVAL_SECONDS)
      }
      try {
        const result = await invoke<RefreshDiscoveryResponse>('refresh_discovery', {
          request: { mode, reason },
        })
        setDiscoveryHosts(result.hosts || [])
        return result
      } catch (error) {
        console.error('Failed to refresh discovery:', error)
        return null
      }
    },
    []
  )

  useEffect(() => {
    const timer = window.setInterval(() => {
      setQuickHeartbeatCountdownSec((prev) => Math.max(0, prev - 1))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [])

  const closeNotice = useCallback((id: number) => {
    setNotices((prev) => prev.filter((item) => item.id !== id))
    const timer = noticeTimersRef.current.get(id)
    if (timer) {
      window.clearTimeout(timer)
      noticeTimersRef.current.delete(id)
    }
  }, [])

  const showNotice = useCallback<ShowNoticeFn>(
    (type, text, options) => {
      const durationMs = options?.durationMs ?? (type === 'error' ? 3_000 : 2_500)
      const id = noticeIdRef.current++
      setNotices((prev) => [...prev, { id, type, text, durationMs }])

      const timer = window.setTimeout(() => {
        setNotices((prev) => prev.filter((item) => item.id !== id))
        noticeTimersRef.current.delete(id)
      }, durationMs)
      noticeTimersRef.current.set(id, timer)
    },
    []
  )

  useEffect(() => {
    loadStatus()
    loadDiscoveryHosts()
    loadFavoriteHosts()
    void refreshDiscovery('quick', 'app-start')

    const interval = setInterval(loadStatus, 3000)
    const quickRefresh = setInterval(() => {
      void refreshDiscovery('quick', 'periodic')
    }, 15_000)

    return () => {
      clearInterval(interval)
      clearInterval(quickRefresh)
    }
  }, [loadStatus, loadDiscoveryHosts, loadFavoriteHosts, refreshDiscovery])

  useEffect(() => {
    if (status?.boundHost) {
      setDraftTarget({
        ip: status.boundHost.ip,
        port: String(status.boundHost.port),
      })
    }
  }, [status?.boundHost?.ip, status?.boundHost?.port])

  useEffect(() => {
    const handleOnline = () => {
      void refreshDiscovery('deep', 'network-online')
    }

    window.addEventListener('online', handleOnline)
    return () => window.removeEventListener('online', handleOnline)
  }, [refreshDiscovery])

  useEffect(() => {
    const bound = status?.boundHost
    const isOfflineBound = Boolean(bound) && status?.status.online === false && status?.status.phase !== 'idle'
    const key = bound ? `${bound.ip}:${bound.port}` : null

    if (isOfflineBound && key && lastBoundOfflineTriggerRef.current !== key) {
      lastBoundOfflineTriggerRef.current = key
      void refreshDiscovery('deep', 'bound-host-offline')
      return
    }

    if (!isOfflineBound) {
      lastBoundOfflineTriggerRef.current = null
    }
  }, [status?.boundHost, status?.status.online, status?.status.phase, refreshDiscovery])

  useEffect(() => {
    return () => {
      noticeTimersRef.current.forEach((timer) => {
        window.clearTimeout(timer)
      })
      noticeTimersRef.current.clear()
    }
  }, [])

  return (
    <div className="bridge-page min-h-screen">
      <main className="bridge-main">
        <div className="max-w-[820px] mx-auto">
          <QuickConnect
            status={status}
            onRefresh={loadStatus}
            targetIp={draftTarget.ip}
            targetPort={draftTarget.port}
            quickHeartbeatCountdownSec={quickHeartbeatCountdownSec}
            onTargetChange={(ip, port) => setDraftTarget({ ip, port })}
            onOpenScanner={() => setScannerOpen(true)}
            favoriteHosts={favoriteListView}
            onFavoriteChanged={loadFavoriteHosts}
            showNotice={showNotice}
            onRefreshDiscovery={(mode) => refreshDiscovery(mode, `quick-connect-${mode}`)}
          />
        </div>
      </main>

      <HostDiscovery
        open={scannerOpen}
        favoriteHosts={favoriteHosts}
        onClose={() => setScannerOpen(false)}
        onScanComplete={() => {
          void loadStatus()
          void loadDiscoveryHosts()
        }}
        onFavoriteChanged={() => {
          void loadFavoriteHosts()
        }}
        showNotice={showNotice}
        onSelectHost={(ip, port) => {
          setDraftTarget({ ip, port: String(port) })
          setScannerOpen(false)
        }}
      />
      <FloatingNoticeHost notices={notices} onClose={closeNotice} />
    </div>
  )
}

export default App
