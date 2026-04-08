import { useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Loader2, Star } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import FavoriteNameDialog from '@/components/FavoriteNameDialog'
import FavoriteSwitchConfirmDialog from '@/components/FavoriteSwitchConfirmDialog'
import EndpointDisplay from '@/components/EndpointDisplay'
import HostStatusPill from '@/components/HostStatusPill'
import type { ShowNoticeFn } from '@/components/FloatingNoticeHost'
import { Input } from '@/components/ui/input'
import { formatEndpointLabel } from '@/lib/endpoint'

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

interface FavoriteHostView {
  ip: string
  port: number
  name: string
  updatedAt: number
  status: 'online' | 'offline' | 'stale' | 'unknown' | string
  lastSeen?: number
  lastOk?: number | null
  rtt?: number
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

interface HostDiagnosis {
  recommendedPort: number
  summary: {
    ok: boolean
    error?: string | null
  }
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

interface Props {
  status: StatusResponse | null
  scanStatus: ScanStatusResponse
  proxyReady: boolean
  onRefresh: () => Promise<void>
  targetIp: string
  quickHeartbeatCountdownSec: number
  onTargetChange: (ip: string) => void
  onOpenScanner: () => void
  favoriteHosts: FavoriteHostView[]
  onFavoriteChanged: () => Promise<void> | void
  showNotice: ShowNoticeFn
  onRefreshDiscovery: (mode: 'quick' | 'deep') => Promise<RefreshDiscoveryResponse | null>
}

const FIXED_CONNECT_PORT = 8000

function isValidIpv4(ip: string): boolean {
  const parts = ip.split('.')
  if (parts.length !== 4) {
    return false
  }

  return parts.every((part) => {
    if (!/^\d+$/.test(part)) {
      return false
    }
    if (part.length > 1 && part.startsWith('0')) {
      return false
    }
    const value = Number(part)
    return value >= 0 && value <= 255
  })
}

function normalizeUiErrorMessage(raw: string, ip?: string, port?: number | string): string {
  const cleaned = raw
    .replace(/^Error:\s*/i, '')
    .replace(/^command\s+\w+\s+failed:\s*/i, '')
    .replace(/^绑定失败:\s*/i, '')
    .replace(/^连接失败:\s*/i, '')
    .trim()
  const normalized = cleaned.toLowerCase()
  const endpoint = ip && port ? `${ip}:${port}` : '目标主机'

  if (
    normalized.includes('no route') ||
    normalized.includes('network is unreachable') ||
    normalized.includes('host is unreachable')
  ) {
    return '网络不可达，请确认与目标主机在同一局域网或已接入 VPN。'
  }

  if (normalized.includes('connection refused') || normalized.includes('refused')) {
    return '连接被拒绝，请确认目标主机已启动 LODOP 服务且端口开放。'
  }

  if (normalized.includes('timeout') || normalized.includes('timed out')) {
    return `连接超时，无法连接到 ${endpoint}，请确认主机在线、端口正确、网络可达。`
  }

  if (normalized.includes('clodopfuncs.js')) {
    return 'LODOP 服务可达性异常，无法获取 CLodopfuncs.js。'
  }

  if (normalized.includes('websocket')) {
    return 'LODOP 通道建立失败，请确认目标服务支持 WebSocket。'
  }

  if (/[\u4e00-\u9fff]/.test(cleaned)) {
    return cleaned
  }

  return '连接失败，请检查网络和服务状态后重试。'
}

export default function QuickConnect({
  status,
  scanStatus,
  proxyReady,
  onRefresh,
  targetIp,
  quickHeartbeatCountdownSec,
  onTargetChange,
  onOpenScanner,
  favoriteHosts,
  onFavoriteChanged,
  showNotice,
  onRefreshDiscovery,
}: Props) {
  const [loadingConnect, setLoadingConnect] = useState(false)
  const [loadingUnbind, setLoadingUnbind] = useState(false)
  const [editingFavorite, setEditingFavorite] = useState<FavoriteHostView | null>(null)
  const [savingFavoriteName, setSavingFavoriteName] = useState(false)
  const [removingFavoriteKey, setRemovingFavoriteKey] = useState<string | null>(null)
  const [pendingSwitchFavorite, setPendingSwitchFavorite] = useState<FavoriteHostView | null>(null)
  const [pendingRemoveFavorite, setPendingRemoveFavorite] = useState<FavoriteHostView | null>(null)
  const [connectingFavoriteKey, setConnectingFavoriteKey] = useState<string | null>(null)

  const connectToHost = async (rawIp: string) => {
    const ip = rawIp.trim()
    if (!ip || !isValidIpv4(ip)) {
      throw new Error('请输入合法的 IPv4 地址（例如 10.202.116.23）')
    }

    const diagnosis = await invoke<HostDiagnosis>('diagnose_host', { ip, port: FIXED_CONNECT_PORT })
    if (!diagnosis.summary.ok) {
      await onRefresh()
      throw new Error(
        normalizeUiErrorMessage(diagnosis.summary.error || '连接诊断失败', ip, FIXED_CONNECT_PORT)
      )
    }

    await invoke('bind_host', { ip, port: FIXED_CONNECT_PORT })
    onTargetChange(ip)
    await onRefresh()
    await onRefreshDiscovery('quick')

    return { ip, port: FIXED_CONNECT_PORT }
  }

  const handleConnect = async () => {
    if (!proxyReady) {
      showNotice('error', '本地代理未监听，无法正常使用 Lodop 服务')
      return
    }

    const ip = targetIp.trim()
    setLoadingConnect(true)
    try {
      const endpoint = await connectToHost(ip)
      showNotice('success', `连接成功：${formatEndpointLabel(endpoint.ip, endpoint.port)}`)
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      showNotice('error', normalizeUiErrorMessage(errorMsg, ip, FIXED_CONNECT_PORT))
    } finally {
      setLoadingConnect(false)
    }
  }

  const handleDisconnect = async () => {
    setLoadingUnbind(true)
    try {
      await invoke('unbind_host')
      await onRefresh()
      showNotice('success', '已断开连接')
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      showNotice('error', `断开连接失败: ${errorMsg}`)
    } finally {
      setLoadingUnbind(false)
    }
  }

  const startEditFavorite = (host: FavoriteHostView) => {
    setEditingFavorite(host)
  }

  const closeFavoriteDialog = () => setEditingFavorite(null)

  const saveFavoriteName = async (name: string) => {
    if (!editingFavorite) {
      return
    }
    setSavingFavoriteName(true)
    try {
      await invoke('upsert_favorite_host', {
        ip: editingFavorite.ip,
        port: editingFavorite.port,
        name,
      })
      await onFavoriteChanged()
      showNotice('success', '备注已保存')
      closeFavoriteDialog()
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      showNotice('error', `保存备注失败: ${errorMsg}`)
    } finally {
      setSavingFavoriteName(false)
    }
  }

  const handleRemoveFavorite = async (host: FavoriteHostView) => {
    const key = host.ip
    setRemovingFavoriteKey(key)
    try {
      await invoke('remove_favorite_host', {
        ip: host.ip,
        port: host.port,
      })
      await onFavoriteChanged()
      await onRefreshDiscovery('quick')
      showNotice('success', '已移除收藏')
      if (editingFavorite && editingFavorite.ip === host.ip && editingFavorite.port === host.port) {
        closeFavoriteDialog()
      }
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      showNotice('error', `移除收藏失败: ${errorMsg}`)
    } finally {
      setRemovingFavoriteKey(null)
    }
  }

  const requestRemoveFavorite = (host: FavoriteHostView) => {
    if (removingFavoriteKey || connectionBusy) {
      return
    }
    setPendingRemoveFavorite(host)
  }

  const cancelRemoveFavorite = () => setPendingRemoveFavorite(null)

  const confirmRemoveFavorite = async () => {
    if (!pendingRemoveFavorite) {
      return
    }
    const target = pendingRemoveFavorite
    setPendingRemoveFavorite(null)
    await handleRemoveFavorite(target)
  }

  const isCurrentBoundHost = (host: FavoriteHostView): boolean => {
    const boundHost = status?.boundHost
    return Boolean(boundHost && boundHost.ip === host.ip && boundHost.port === FIXED_CONNECT_PORT)
  }

  const requestSwitchTarget = (host: FavoriteHostView) => {
    if (isCurrentBoundHost(host)) {
      return
    }
    setPendingSwitchFavorite(host)
  }

  const cancelSwitchTarget = () => setPendingSwitchFavorite(null)

  const confirmSwitchTarget = async () => {
    if (!pendingSwitchFavorite) {
      return
    }
    if (!proxyReady) {
      showNotice('error', '本地代理未监听，无法正常使用 Lodop 服务')
      return
    }

    const target = pendingSwitchFavorite
    const key = target.ip
    const previousBound = status?.boundHost
    setPendingSwitchFavorite(null)

    setConnectingFavoriteKey(key)
    try {
      const isSameHost = Boolean(
        previousBound && previousBound.ip === target.ip && previousBound.port === FIXED_CONNECT_PORT
      )
      if (previousBound && !isSameHost) {
        await invoke('unbind_host')
        await onRefresh()
      }

      const endpoint = await connectToHost(target.ip)
      showNotice('success', `连接成功：${formatEndpointLabel(endpoint.ip, endpoint.port)}`)
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      showNotice('error', normalizeUiErrorMessage(errorMsg, target.ip, FIXED_CONNECT_PORT))
      await onRefresh()
    } finally {
      setConnectingFavoriteKey(null)
    }
  }

  const isOnline = status?.status.online ?? false
  const cooldownSeconds = Math.max(0, Math.ceil((scanStatus.cooldownRemainingMs ?? 0) / 1000))
  const scannerButtonText = scanStatus.isScanning
    ? '高级扫描（扫描中）'
    : cooldownSeconds > 0
      ? `高级扫描（冷却 ${cooldownSeconds}s）`
      : '高级扫描'
  const hasFavoriteConnecting = Boolean(connectingFavoriteKey)
  const targetInputsLocked = isOnline || loadingConnect || loadingUnbind || hasFavoriteConnecting
  const connectionBusy = loadingConnect || loadingUnbind || hasFavoriteConnecting
  const connectBlockedByProxy = !proxyReady && !isOnline
  const currentPhase = status?.status.phase ?? 'idle'
  const shouldShowError = Boolean(status?.status.error) && currentPhase !== 'idle'
  const pendingSwitchEndpoint = useMemo(() => {
    if (!pendingSwitchFavorite) {
      return ''
    }
    return formatEndpointLabel(pendingSwitchFavorite.ip, FIXED_CONNECT_PORT)
  }, [pendingSwitchFavorite])
  const pendingRemoveEndpoint = useMemo(() => {
    if (!pendingRemoveFavorite) {
      return ''
    }
    return formatEndpointLabel(pendingRemoveFavorite.ip, pendingRemoveFavorite.port)
  }, [pendingRemoveFavorite])
  const currentBoundEndpoint = useMemo(() => {
    const host = status?.boundHost
    if (!host) {
      return ''
    }
    return formatEndpointLabel(host.ip, host.port)
  }, [status?.boundHost?.ip, status?.boundHost?.port])

  return (
    <div className="flex h-full min-h-0 flex-col space-y-4">
      <Card className="shrink-0 rounded-2xl border-[color:var(--bridge-border)]/55 bg-[color:var(--bridge-surface)] shadow-[0_14px_36px_-28px_rgba(0,34,110,0.35)]">
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-3">
            <div className="space-y-2">
              <label className="text-[11px] font-bold uppercase tracking-[0.16em] text-slate-500">主机 IP</label>
              <Input
                placeholder="手动输入目标主机，例如 10.202.116.23"
                value={targetIp}
                onChange={(event) => onTargetChange(event.target.value)}
                disabled={targetInputsLocked}
                className="h-10 rounded-xl border-[color:var(--bridge-border)] bg-[color:var(--bridge-panel)] text-slate-900 font-mono"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <div className="flex items-center gap-2.5">
              <Button
                onClick={() => void (isOnline ? handleDisconnect() : handleConnect())}
                disabled={connectionBusy || connectBlockedByProxy}
                className={
                  isOnline
                    ? 'h-10 w-[112px] rounded-xl bg-rose-600 text-white shadow-[0_16px_30px_-22px_rgba(190,18,60,0.85)] hover:bg-rose-700'
                    : 'h-10 w-[112px] rounded-xl bg-gradient-to-r from-[color:var(--bridge-primary)] to-[color:var(--bridge-primary-strong)] text-white shadow-[0_16px_30px_-22px_rgba(0,86,193,0.85)] hover:brightness-110'
                }
              >
                {isOnline ? (loadingUnbind ? '断开中...' : '断开连接') : (loadingConnect ? '连接中...' : '连接')}
              </Button>
              <Button
                onClick={onOpenScanner}
                variant="outline"
                disabled={isOnline || !proxyReady}
                className="h-10 px-4 rounded-xl border-[color:var(--bridge-border)] bg-white text-slate-700 hover:bg-[color:var(--bridge-panel)]"
              >
                {scannerButtonText}
              </Button>
            </div>
            <HostStatusPill
              status={isOnline ? 'online' : 'offline'}
              showPulse={isOnline}
              className="ml-auto shrink-0"
            />
          </div>
          {shouldShowError && (
            <div className="text-xs text-slate-600 leading-5">
              <span className={isOnline ? 'ml-2 text-rose-700' : 'text-rose-700'}>错误：{status?.status.error}</span>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="flex flex-1 min-h-0 flex-col overflow-hidden rounded-2xl border-[color:var(--bridge-border)]/55 bg-[color:var(--bridge-surface)] shadow-[0_14px_36px_-28px_rgba(0,34,110,0.35)]">
        <CardHeader className="shrink-0 pb-2">
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="text-base font-bold leading-none text-slate-900">收藏列表</CardTitle>
            <div className="inline-flex items-center gap-2 rounded-full border border-[color:var(--bridge-border)] bg-[color:var(--bridge-panel)] px-2.5 py-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.55)]">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
              <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500">心跳</span>
              <span className="rounded-md bg-white px-1.5 py-0.5 text-[12px] font-semibold font-mono tabular-nums text-slate-700">
                {quickHeartbeatCountdownSec}s
              </span>
            </div>
          </div>
        </CardHeader>
        <CardContent className="bridge-scrollbar flex-1 min-h-0 space-y-2.5 overflow-y-auto pr-1">
          {favoriteHosts.length === 0 ? (
            <div className="rounded-xl border border-dashed border-[color:var(--bridge-border)] bg-[color:var(--bridge-panel)]/50 px-4 py-4 text-sm text-slate-500">
              暂无收藏，可在“高级扫描”中添加。
            </div>
          ) : (
            favoriteHosts.map((host) => {
              const key = host.ip
              const isRemoving = removingFavoriteKey === key
              const isCurrentTarget = isCurrentBoundHost(host)
              const isConnectingCurrent = connectingFavoriteKey === key
              return (
                <div
                  key={key}
                  className={`rounded-xl border px-3 py-2.5 transition-colors ${
                    isCurrentTarget
                      ? 'border-[color:var(--bridge-primary)]/45 bg-[color:var(--bridge-primary)]/[0.06] hover:border-[color:var(--bridge-primary)]/55'
                      : 'border-[color:var(--bridge-border)]/65 bg-[color:var(--bridge-panel)]/40 hover:border-[color:var(--bridge-primary)]/35'
                  }`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0 flex-1 rounded-lg px-1 py-0.5">
                      <EndpointDisplay
                        endpoint={{
                          ip: host.ip,
                          port: host.port,
                          status: host.status,
                          rtt: host.rtt,
                          copyValue: `${host.ip}:${host.port}`,
                        }}
                        compact
                        showCopy
                        emphasize={isCurrentTarget ? 'primary' : 'secondary'}
                        className={isCurrentTarget ? 'bg-[color:var(--bridge-primary)]/[0.08]' : undefined}
                      />
                      {host.name ? (
                        <p className="mt-1.5 truncate px-1 text-xs text-slate-500">备注：{host.name}</p>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => requestSwitchTarget(host)}
                        disabled={isCurrentTarget || isRemoving || connectionBusy || !proxyReady}
                        className={
                          isCurrentTarget
                            ? 'h-8 rounded-lg border-emerald-300 bg-emerald-100 text-[12px] text-emerald-800 disabled:opacity-100'
                            : 'h-8 rounded-lg border-[color:var(--bridge-border)] bg-white text-[12px] text-slate-700 hover:bg-slate-50'
                        }
                      >
                        {isConnectingCurrent ? '连接中...' : '连接'}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => startEditFavorite(host)}
                        disabled={isRemoving}
                        className="h-8 rounded-lg border-[color:var(--bridge-border)] bg-white text-[12px] text-slate-700 hover:bg-slate-50"
                      >
                        备注
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => requestRemoveFavorite(host)}
                        disabled={isRemoving || connectionBusy}
                        aria-label={`取消收藏 ${host.ip}`}
                        title="取消收藏"
                        className="h-8 w-8 p-0 rounded-lg border-amber-200 bg-amber-50 text-amber-600 hover:bg-amber-100 hover:text-amber-700"
                      >
                        {isRemoving ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Star className="h-4 w-4 fill-current" />
                        )}
                      </Button>
                    </div>
                  </div>
                </div>
              )
            })
          )}
        </CardContent>
      </Card>
      <FavoriteNameDialog
        open={Boolean(editingFavorite)}
        initialName={editingFavorite?.name ?? ''}
        loading={savingFavoriteName}
        onConfirm={saveFavoriteName}
        onCancel={closeFavoriteDialog}
      />
      <FavoriteSwitchConfirmDialog
        open={Boolean(pendingSwitchFavorite)}
        mode="connect"
        endpoint={pendingSwitchEndpoint}
        currentEndpoint={currentBoundEndpoint}
        onCancel={cancelSwitchTarget}
        onConfirm={() => void confirmSwitchTarget()}
        confirmLoading={hasFavoriteConnecting}
      />
      <FavoriteSwitchConfirmDialog
        open={Boolean(pendingRemoveFavorite)}
        mode="remove"
        endpoint={pendingRemoveEndpoint}
        currentEndpoint={null}
        onCancel={cancelRemoveFavorite}
        onConfirm={() => void confirmRemoveFavorite()}
        confirmLoading={Boolean(removingFavoriteKey)}
      />
    </div>
  )
}
