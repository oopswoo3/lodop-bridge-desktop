import { useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
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

interface ProgressData {
  scanned: number
  total: number
  found: number
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

interface Props {
  open: boolean
  favoriteHosts: FavoriteHost[]
  onClose: () => void
  onSelectHost: (ip: string, port: number) => void
  onFavoriteChanged: () => void
  showNotice: ShowNoticeFn
  onScanComplete?: () => void
}

export default function HostDiscovery({
  open,
  favoriteHosts,
  onClose,
  onSelectHost,
  onFavoriteChanged,
  showNotice,
  onScanComplete,
}: Props) {
  const [isScanning, setIsScanning] = useState(false)
  const [showProgress, setShowProgress] = useState(false)
  const [hosts, setHosts] = useState<HostInfo[]>([])
  const [progress, setProgress] = useState<ProgressData>({ scanned: 0, total: 0, found: 0 })
  const [savingFavoriteKey, setSavingFavoriteKey] = useState<string | null>(null)

  useEffect(() => {
    void loadResults()

    const unlistenProgress = listen<ProgressData>('scan-progress', (event) => {
      setProgress(event.payload)
      setIsScanning(event.payload.scanned < event.payload.total)
    })

    const unlistenHostFound = listen<{ host: HostInfo }>('host-found', (event) => {
      setHosts((prev) => upsertHost(prev, event.payload.host))
    })

    const unlistenScanComplete = listen<ScanCompleteEvent>('scan-complete', async (event) => {
      setIsScanning(false)
      setShowProgress(false)
      await loadResults()
      onScanComplete?.()
      showNotice('success', event.payload.cancelled ? '扫描已停止，可用列表已更新' : '扫描完成，可用列表已更新')
    })

    const unlistenScanError = listen<string>('scan-error', (event) => {
      setIsScanning(false)
      setShowProgress(false)
      showNotice('error', typeof event.payload === 'string' ? event.payload : '扫描失败')
    })

    return () => {
      unlistenProgress.then((fn) => fn())
      unlistenHostFound.then((fn) => fn())
      unlistenScanComplete.then((fn) => fn())
      unlistenScanError.then((fn) => fn())
    }
  }, [onScanComplete, showNotice])

  const usableHosts = useMemo(() => {
    return [...hosts]
      .filter((host) => isUsableHost(host))
      .sort((a, b) => (a.rtt ?? Number.MAX_SAFE_INTEGER) - (b.rtt ?? Number.MAX_SAFE_INTEGER))
  }, [hosts])
  const favoriteByKey = useMemo(() => {
    const map = new Map<string, FavoriteHost>()
    favoriteHosts.forEach((host) => {
      map.set(getHostKey(host.ip, host.port), host)
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
    setHosts([])
    setProgress({ scanned: 0, total: 0, found: 0 })
    setIsScanning(true)
    setShowProgress(true)

    try {
      await invoke('start_scan')
    } catch (err: unknown) {
      setIsScanning(false)
      setShowProgress(false)
      const errorMsg = err instanceof Error ? err.message : String(err)
      showNotice('error', errorMsg || '扫描失败')
    }
  }

  const handleStopScan = async () => {
    setShowProgress(false)
    try {
      await invoke('stop_scan')
      showNotice('success', '已发送停止请求')
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      showNotice('error', `停止扫描失败: ${errorMsg}`)
    }
  }

  const handleToggleScan = async () => {
    if (isScanning) {
      await handleStopScan()
      return
    }
    await handleStartScan()
  }

  const handleSelect = (host: HostInfo) => {
    onSelectHost(host.ip, host.port)
  }

  const handleFavoriteUpsert = async (host: HostInfo) => {
    const key = getHostKey(host.ip, host.port)
    const favorite = favoriteByKey.get(key)
    const nextName = favorite?.name ?? ''

    setSavingFavoriteKey(key)
    try {
      await invoke('upsert_favorite_host', {
        ip: host.ip,
        port: host.port,
        name: nextName,
      })
      onFavoriteChanged()
      showNotice('success', favorite ? '收藏已更新' : '已加入收藏')
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      showNotice('error', `收藏失败: ${errorMsg}`)
    } finally {
      setSavingFavoriteKey(null)
    }
  }

  useEffect(() => {
    if (open) {
      void loadResults()
    } else {
      setShowProgress(false)
    }
  }, [open])

  if (!open) {
    return null
  }

  return (
    <div className="bridge-drawer-overlay" onClick={onClose}>
      <aside className="bridge-drawer" onClick={(event) => event.stopPropagation()}>
        <Card className="h-full rounded-none border-0 bg-white shadow-none">
          <CardHeader className="pb-2 border-b border-[color:var(--bridge-border)]">
            <div className="flex items-start justify-between gap-4">
              <div>
                <CardTitle className="text-lg leading-tight font-bold tracking-tight text-slate-900">
                  扫描局域网 LODOP 主机
                </CardTitle>
                <p className="mt-1 text-xs text-slate-600">可发现并选择内网可用主机。</p>
              </div>
              <Button
                variant="outline"
                onClick={onClose}
                className="h-8 w-8 rounded-lg border-[color:var(--bridge-border)] bg-white p-0 text-slate-600 hover:bg-slate-50"
              >
                ×
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4 overflow-y-auto h-[calc(100vh-84px)] py-4">
            <div className="flex flex-wrap gap-2 rounded-xl bg-[color:var(--bridge-panel)] p-2 border border-[color:var(--bridge-border)]/55">
              <Button
                onClick={() => void handleToggleScan()}
                className={
                  isScanning
                    ? 'h-8 rounded-lg bg-rose-600 text-white hover:bg-rose-700'
                    : 'h-8 rounded-lg bg-gradient-to-r from-[color:var(--bridge-primary)] to-[color:var(--bridge-primary-strong)] text-white hover:brightness-110'
                }
              >
                {isScanning ? '停止扫描' : '开始扫描'}
              </Button>
            </div>

            {showProgress && (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-[11px] uppercase tracking-[0.14em] text-slate-500 font-semibold">
                  <span>扫描进度</span>
                  <span>{progress.total > 0 ? `${Math.min(100, Math.round((progress.scanned / progress.total) * 100))}%` : '0%'}</span>
                </div>
                <Progress
                  value={progress.total > 0 ? (progress.scanned / progress.total) * 100 : 0}
                  className="h-2 rounded-full bg-slate-200"
                />
                <div className="text-sm text-slate-600">
                  已扫描: <span className="font-semibold">{progress.scanned}</span> / {progress.total}
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
                  const isFavorited = favoriteByKey.has(key)
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
                            className="h-8 rounded-lg bg-white text-[color:var(--bridge-primary)] border border-[color:var(--bridge-primary)]/25 hover:bg-[color:var(--bridge-primary)] hover:text-white"
                          >
                            选择
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void handleFavoriteUpsert(host)}
                            disabled={isFavorited || savingFavoriteKey === key}
                            className={
                              isFavorited
                                ? 'h-8 rounded-lg border-emerald-200 bg-emerald-50 text-emerald-700'
                                : 'h-8 rounded-lg border-[color:var(--bridge-border)] bg-white text-slate-700 hover:bg-slate-50'
                            }
                          >
                            {savingFavoriteKey === key ? '收藏中...' : isFavorited ? '已收藏' : '收藏'}
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
