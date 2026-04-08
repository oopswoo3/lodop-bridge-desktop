import { useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { Loader2, Star } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import EndpointDisplay from '@/components/EndpointDisplay'
import type { ShowNoticeFn } from '@/components/FloatingNoticeHost'
import { Progress } from '@/components/ui/progress'

interface HostInfo {
  ip: string
  port: number
  hostname?: string
  os?: string
  version?: string
  rtt?: number
  tcp_ok?: boolean
  script_ok?: boolean
  timestamp: number
}

interface ScanCompleteEvent {
  found: number
  cancelled?: boolean
}

interface FavoriteHost {
  ip: string
  port: number
  name: string
  updatedAt: number
}

interface ScanStatusResponse {
  isScanning: boolean
  scanned: number
  total: number
  found: number
  cooldownRemainingMs?: number | null
}

interface Props {
  open: boolean
  scanStatus: ScanStatusResponse
  favoriteHosts: FavoriteHost[]
  onClose: () => void
  onSelectHost: (ip: string, port: number) => void
  onFavoriteChanged: () => void
  showNotice: ShowNoticeFn
  onScanComplete?: () => void
}

export default function HostDiscovery({
  open,
  scanStatus,
  favoriteHosts,
  onClose,
  onSelectHost,
  onFavoriteChanged,
  showNotice,
  onScanComplete,
}: Props) {
  const [hosts, setHosts] = useState<HostInfo[]>([])
  const [savingFavoriteKey, setSavingFavoriteKey] = useState<string | null>(null)
  const [scanStarting, setScanStarting] = useState(false)
  const isScanning = scanStatus.isScanning
  const effectiveScanning = isScanning || scanStarting
  const cooldownSeconds = Math.max(0, Math.ceil((scanStatus.cooldownRemainingMs ?? 0) / 1000))
  const inCooldown = !effectiveScanning && cooldownSeconds > 0
  const showProgress = effectiveScanning

  useEffect(() => {
    void loadResults()

    const unlistenHostFound = listen<{ host: HostInfo }>('host-found', (event) => {
      setHosts((prev) => upsertHost(prev, event.payload.host))
    })

    const unlistenScanComplete = listen<ScanCompleteEvent>('scan-complete', async (event) => {
      setScanStarting(false)
      await loadResults()
      onScanComplete?.()
      showNotice('success', event.payload.cancelled ? '扫描已停止，可用列表已更新' : '扫描完成，可用列表已更新')
    })

    const unlistenScanError = listen<string>('scan-error', (event) => {
      setScanStarting(false)
      showNotice('error', typeof event.payload === 'string' ? event.payload : '扫描失败')
    })

    return () => {
      unlistenHostFound.then((fn) => fn())
      unlistenScanComplete.then((fn) => fn())
      unlistenScanError.then((fn) => fn())
    }
  }, [onScanComplete, showNotice])

  const usableHosts = useMemo(() => {
    const deduped = new Map<string, HostInfo>()
    hosts.forEach((host) => {
      if (!isUsableHost(host)) {
        return
      }
      deduped.set(getHostKey(host.ip, host.port), host)
    })
    return [...deduped.values()].sort(
      (a, b) => (a.rtt ?? Number.MAX_SAFE_INTEGER) - (b.rtt ?? Number.MAX_SAFE_INTEGER)
    )
  }, [hosts])
  const favoriteByKey = useMemo(() => {
    const map = new Map<string, FavoriteHost>()
    favoriteHosts.forEach((host) => {
      map.set(host.ip, host)
    })
    return map
  }, [favoriteHosts])

  const loadResults = async () => {
    try {
      const results = await invoke<HostInfo[]>('get_scan_results')
      setHosts(results || [])
    } catch (err) {
      console.error('Failed to load scan results:', err)
    }
  }

  const handleStartScan = async () => {
    if (inCooldown) {
      return
    }
    setHosts([])
    setScanStarting(true)

    try {
      await invoke('start_scan')
    } catch (err: unknown) {
      setScanStarting(false)
      const errorMsg = err instanceof Error ? err.message : String(err)
      showNotice('error', errorMsg || '扫描失败')
    }
  }

  const handleStopScan = async () => {
    try {
      await invoke('stop_scan')
      setScanStarting(false)
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      showNotice('error', `停止扫描失败: ${errorMsg}`)
    }
  }

  const handleToggleScan = async () => {
    if (effectiveScanning) {
      await handleStopScan()
      return
    }
    if (inCooldown) {
      return
    }
    await handleStartScan()
  }

  const handleRequestClose = () => {
    if (effectiveScanning) {
      return
    }
    onClose()
  }

  const handleSelect = (host: HostInfo) => {
    onSelectHost(host.ip, host.port)
  }

  const handleFavoriteToggle = async (host: HostInfo) => {
    const key = host.ip
    const favorite = favoriteByKey.get(key)

    setSavingFavoriteKey(key)
    try {
      if (favorite) {
        await invoke('remove_favorite_host', {
          ip: host.ip,
          port: favorite.port,
        })
      } else {
        await invoke('upsert_favorite_host', {
          ip: host.ip,
          port: host.port,
          name: '',
        })
      }
      await Promise.resolve(onFavoriteChanged())
      showNotice('success', favorite ? '已取消收藏' : '已加入收藏')
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      showNotice('error', favorite ? `取消收藏失败: ${errorMsg}` : `收藏失败: ${errorMsg}`)
    } finally {
      setSavingFavoriteKey(null)
    }
  }

  useEffect(() => {
    if (scanStatus.isScanning) {
      setScanStarting(false)
    }
  }, [scanStatus.isScanning])

  useEffect(() => {
    if (open) {
      void loadResults()
    } else {
      setScanStarting(false)
    }
  }, [open])

  if (!open) {
    return null
  }

  return (
    <div className="bridge-drawer-overlay" onClick={handleRequestClose}>
      <aside className="bridge-drawer" onClick={(event) => event.stopPropagation()}>
        <Card className="flex h-full min-h-0 flex-col rounded-none border-0 bg-white shadow-none">
          <CardHeader className="shrink-0 pb-2 border-b border-[color:var(--bridge-border)]">
            <div className="flex items-start justify-between gap-4">
              <div>
                <CardTitle className="text-lg leading-tight font-bold tracking-tight text-slate-900">
                  扫描局域网 LODOP 主机
                </CardTitle>
                <p className="mt-1 text-xs text-slate-600">可发现并选择内网可用主机。</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  variant="outline"
                  onClick={() => void handleToggleScan()}
                  disabled={!effectiveScanning && inCooldown}
                  className={
                    effectiveScanning
                      ? 'h-8 rounded-lg border-rose-200 bg-rose-50 px-3 text-rose-700 hover:bg-rose-100'
                      : inCooldown
                        ? 'h-8 rounded-lg border-[color:var(--bridge-border)] bg-slate-100 px-3 text-slate-500'
                        : 'h-8 rounded-lg border-[color:var(--bridge-border)] bg-white px-3 text-[color:var(--bridge-primary)] hover:bg-[color:var(--bridge-panel)]'
                  }
                >
                  {effectiveScanning ? '停止扫描' : inCooldown ? `冷却 ${cooldownSeconds}s` : '开始扫描'}
                </Button>
                <Button
                  variant="outline"
                  onClick={handleRequestClose}
                  disabled={effectiveScanning}
                  className="h-8 w-8 rounded-lg border-[color:var(--bridge-border)] bg-white p-0 text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  ×
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="bridge-scrollbar flex-1 min-h-0 space-y-4 overflow-y-auto py-4">
            {showProgress && (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-[11px] uppercase tracking-[0.14em] text-slate-500 font-semibold">
                  <span>扫描进度</span>
                  <span>{scanStatus.total > 0 ? `${Math.min(100, Math.round((scanStatus.scanned / scanStatus.total) * 100))}%` : '0%'}</span>
                </div>
                <Progress
                  value={scanStatus.total > 0 ? (scanStatus.scanned / scanStatus.total) * 100 : 0}
                  className="h-2 rounded-full bg-slate-200"
                />
                <div className="text-sm text-slate-600">
                  已扫描: <span className="font-semibold">{scanStatus.scanned}</span> / {scanStatus.total}
                  <span className="mx-2 text-slate-400">|</span>
                  可用: <span className="font-semibold">{usableHosts.length}</span>
                </div>
              </div>
            )}

            <div className="space-y-2.5 pb-3">
              {usableHosts.length === 0 ? (
                <div className="rounded-xl border border-dashed border-[color:var(--bridge-border)] bg-[color:var(--bridge-panel)]/55 px-4 py-6 text-center text-sm text-slate-500">
                  暂无可用 LODOP 主机
                </div>
              ) : (
                usableHosts.map((host) => {
                  const key = `${host.ip}:${host.port}`
                  const favoriteKey = host.ip
                  const isFavorited = favoriteByKey.has(favoriteKey)
                  return (
                    <div
                      key={key}
                      className="rounded-xl border border-[color:var(--bridge-border)]/65 bg-[color:var(--bridge-panel)]/40 p-3 hover:border-[color:var(--bridge-primary)]/35 transition-colors"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0 flex-1 pr-2">
                          <EndpointDisplay
                            endpoint={{
                              ip: host.ip,
                              port: host.port,
                              rtt: host.rtt,
                              status: 'online',
                              copyValue: `${host.ip}:${host.port}`,
                            }}
                            showCopy
                            compact
                            emphasize="secondary"
                          />
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <Button
                            size="sm"
                            onClick={() => handleSelect(host)}
                            disabled={effectiveScanning}
                            className="h-8 rounded-lg bg-white text-[color:var(--bridge-primary)] border border-[color:var(--bridge-primary)]/25 hover:bg-[color:var(--bridge-primary)] hover:text-white"
                          >
                            选择
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void handleFavoriteToggle(host)}
                            disabled={savingFavoriteKey === favoriteKey}
                            aria-label={isFavorited ? `取消收藏 ${host.ip}` : `收藏 ${host.ip}`}
                            title={isFavorited ? '取消收藏' : '收藏'}
                            className={
                              isFavorited
                                ? 'h-8 w-8 p-0 rounded-lg border-amber-200 bg-amber-50 text-amber-600 hover:bg-amber-100'
                                : 'h-8 w-8 p-0 rounded-lg border-[color:var(--bridge-border)] bg-white text-slate-500 hover:bg-slate-50 hover:text-amber-500'
                            }
                          >
                            {savingFavoriteKey === favoriteKey ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <Star className={`h-4 w-4 ${isFavorited ? 'fill-current' : ''}`} />
                            )}
                          </Button>
                        </div>
                      </div>
                    </div>
                  )
                })
              )}
            </div>
          </CardContent>
        </Card>
      </aside>
    </div>
  )
}

function upsertHost(hosts: HostInfo[], incoming: HostInfo): HostInfo[] {
  const key = getHostKey(incoming.ip, incoming.port)
  const index = hosts.findIndex((item) => getHostKey(item.ip, item.port) === key)
  if (index === -1) {
    return [...hosts, incoming]
  }
  const next = [...hosts]
  next[index] = incoming
  return next
}

function getHostKey(ip: string, port: number): string {
  return `${ip}:${port}`
}

function isUsableHost(host: HostInfo): boolean {
  return host.tcp_ok === true && host.script_ok === true
}
