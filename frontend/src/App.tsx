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

interface ScanStatusResponse {
  isScanning: boolean
  scanned: number
  total: number
  found: number
  cooldownRemainingMs?: number | null
}

interface ProxyInfo {
  port: number
  baseUrl: string
  demoUrl: string
  configuredPorts: number[]
  activePorts: number[]
  ready: boolean
  lastError?: string | null
}

const QUICK_HEARTBEAT_INTERVAL_SECONDS = 15

function App() {
  const [status, setStatus] = useState<StatusResponse | null>(null)
  const [discoveryHosts, setDiscoveryHosts] = useState<DiscoveryHost[]>([])
  const [favoriteHosts, setFavoriteHosts] = useState<FavoriteHost[]>([])
  const [notices, setNotices] = useState<NoticeItem[]>([])
  const [scannerOpen, setScannerOpen] = useState(false)
  const [proxyInfo, setProxyInfo] = useState<ProxyInfo | null>(null)
  const [quickHeartbeatCountdownSec, setQuickHeartbeatCountdownSec] = useState(QUICK_HEARTBEAT_INTERVAL_SECONDS)
  const [scanStatus, setScanStatus] = useState<ScanStatusResponse>({
    isScanning: false,
    scanned: 0,
    total: 0,
    found: 0,
    cooldownRemainingMs: null,
  })
  const [draftTargetIp, setDraftTargetIp] = useState('')
  const lastBoundOfflineTriggerRef = useRef<string | null>(null)
  const noticeIdRef = useRef(1)
  const noticeTimersRef = useRef<Map<number, number>>(new Map())
  const discoveryByEndpoint = useMemo(() => {
    const map = new Map<string, DiscoveryHost>()
    discoveryHosts.forEach((host) => {
      map.set(`${host.ip}:${host.port}`, host)
    })
    return map
  }, [discoveryHosts])
  const discoveryByIp = useMemo(() => {
    const map = new Map<string, DiscoveryHost>()
    discoveryHosts.forEach((host) => {
      if (!map.has(host.ip)) {
        map.set(host.ip, host)
      }
    })
    return map
  }, [discoveryHosts])
  const favoriteListView = useMemo<FavoriteHostView[]>(
    () =>
      favoriteHosts.map((host) => {
        const discovery = discoveryByEndpoint.get(`${host.ip}:${host.port}`) ?? discoveryByIp.get(host.ip)
        return {
          ...host,
          status: discovery?.status ?? 'unknown',
          lastSeen: discovery?.lastSeen,
          lastOk: discovery?.lastOk,
          rtt: discovery?.rtt,
        }
      }),
    [favoriteHosts, discoveryByEndpoint, discoveryByIp]
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

  const loadScanStatus = useCallback(async () => {
    try {
      const result = await invoke<ScanStatusResponse>('get_scan_status')
      setScanStatus(result)
    } catch (error) {
      console.error('Failed to get scan status:', error)
    }
  }, [])

  const loadProxyInfo = useCallback(async () => {
    try {
      const result = await invoke<ProxyInfo>('get_proxy_info')
      setProxyInfo(result)
    } catch (error) {
      console.error('Failed to get proxy info:', error)
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
    void loadProxyInfo()
    void loadScanStatus()
    void refreshDiscovery('quick', 'app-start')

    const interval = setInterval(loadStatus, 3000)
    const proxyPoll = setInterval(() => {
      void loadProxyInfo()
    }, 2000)
    const scanStatusPoll = setInterval(() => {
      void loadScanStatus()
    }, 1_000)
    const quickRefresh = setInterval(() => {
      void refreshDiscovery('quick', 'periodic')
    }, 15_000)

    return () => {
      clearInterval(interval)
      clearInterval(proxyPoll)
      clearInterval(scanStatusPoll)
      clearInterval(quickRefresh)
    }
  }, [loadStatus, loadDiscoveryHosts, loadFavoriteHosts, loadProxyInfo, loadScanStatus, refreshDiscovery])

  useEffect(() => {
    if (status?.boundHost) {
      setDraftTargetIp(status.boundHost.ip)
    }
  }, [status?.boundHost?.ip])

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

  useEffect(() => {
    const shouldLockScroll = scannerOpen
    const html = document.documentElement
    const body = document.body

    if (shouldLockScroll) {
      html.classList.add('bridge-lock-scroll')
      body.classList.add('bridge-lock-scroll')
    } else {
      html.classList.remove('bridge-lock-scroll')
      body.classList.remove('bridge-lock-scroll')
    }

    return () => {
      html.classList.remove('bridge-lock-scroll')
      body.classList.remove('bridge-lock-scroll')
    }
  }, [scannerOpen])

  const handleScannerScanComplete = useCallback(() => {
    void loadStatus()
    void loadDiscoveryHosts()
    void loadScanStatus()
  }, [loadStatus, loadDiscoveryHosts, loadScanStatus])

  const proxyReady = proxyInfo?.ready ?? true

  return (
    <div className="bridge-page flex h-[100dvh] flex-col overflow-hidden">
      <main className="bridge-main flex-1 min-h-0 overflow-hidden">
        <div className="mx-auto flex h-full w-full min-h-0 flex-col">
          {!proxyReady && (
            <div className="mb-3 shrink-0 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
              <span>本地代理未监听，无法正常使用 Lodop 服务</span>
            </div>
          )}
          <div className="flex-1 min-h-0">
            <QuickConnect
              status={status}
              scanStatus={scanStatus}
              proxyReady={proxyReady}
              onRefresh={loadStatus}
              targetIp={draftTargetIp}
              quickHeartbeatCountdownSec={quickHeartbeatCountdownSec}
              onTargetChange={setDraftTargetIp}
              onOpenScanner={() => setScannerOpen(true)}
              favoriteHosts={favoriteListView}
              onFavoriteChanged={loadFavoriteHosts}
              showNotice={showNotice}
              onRefreshDiscovery={(mode) => refreshDiscovery(mode, `quick-connect-${mode}`)}
            />
          </div>
        </div>
      </main>

      <HostDiscovery
        open={scannerOpen}
        scanStatus={scanStatus}
        favoriteHosts={favoriteHosts}
        onClose={() => setScannerOpen(false)}
        onScanComplete={handleScannerScanComplete}
        onFavoriteChanged={() => {
          void loadFavoriteHosts()
        }}
        showNotice={showNotice}
        onSelectHost={(ip) => {
          setDraftTargetIp(ip)
          setScannerOpen(false)
        }}
      />
      <FloatingNoticeHost notices={notices} onClose={closeNotice} />
    </div>
  )
}

export default App
