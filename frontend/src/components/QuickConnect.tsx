import { useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import FavoriteNameDialog from '@/components/FavoriteNameDialog'
import FavoriteSwitchConfirmDialog from '@/components/FavoriteSwitchConfirmDialog'
import EndpointDisplay from '@/components/EndpointDisplay'
import HostStatusPill from '@/components/HostStatusPill'
import type { ShowNoticeFn } from '@/components/FloatingNoticeHost'
import { Input } from '@/components/ui/input'

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

interface Props {
  status: StatusResponse | null
  onRefresh: () => Promise<void>
  targetIp: string
  targetPort: string
  quickHeartbeatCountdownSec: number
  onTargetChange: (ip: string, port: string) => void
  onOpenScanner: () => void
  favoriteHosts: FavoriteHostView[]
  onFavoriteChanged: () => Promise<void> | void
  showNotice: ShowNoticeFn
  onRefreshDiscovery: (mode: 'quick' | 'deep') => Promise<RefreshDiscoveryResponse | null>
}

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
  onRefresh,
  targetIp,
  targetPort,
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

  const connectToHost = async (rawIp: string, rawPort: string | number) => {
    const ip = rawIp.trim()
    const port = Number(rawPort)
    if (!ip || !Number.isFinite(port) || port <= 0 || port > 65535 || !isValidIpv4(ip)) {
      throw new Error('请输入合法的 IPv4 地址和端口（例如 10.202.116.23:8000）')
    }

    const diagnosis = await invoke<HostDiagnosis>('diagnose_host', { ip, port })
    if (!diagnosis.summary.ok) {
      await onRefresh()
      throw new Error(
        normalizeUiErrorMessage(diagnosis.summary.error || '连接诊断失败', ip, diagnosis.recommendedPort || port)
      )
    }

    const bindPort = diagnosis.recommendedPort || port
    await invoke('bind_host', { ip, port: bindPort })
    onTargetChange(ip, String(bindPort))
    await onRefresh()
    await onRefreshDiscovery('quick')

    return { ip, port: bindPort }
  }

  const handleConnect = async () => {
    const ip = targetIp.trim()
    const port = Number(targetPort)

    setLoadingConnect(true)
    try {
      const endpoint = await connectToHost(ip, port)
      showNotice('success', `连接成功：${endpoint.ip}:${endpoint.port}`)
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      showNotice('error', normalizeUiErrorMessage(errorMsg, ip, port))
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
    const key = `${host.ip}:${host.port}`
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
    return Boolean(boundHost && boundHost.ip === host.ip && boundHost.port === host.port)
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

    const target = pendingSwitchFavorite
    const key = `${target.ip}:${target.port}`
    const previousBound = status?.boundHost
    setPendingSwitchFavorite(null)

    setConnectingFavoriteKey(key)
    try {
      const isSameHost = Boolean(previousBound && previousBound.ip === target.ip && previousBound.port === target.port)
      if (previousBound && !isSameHost) {
        await invoke('unbind_host')
        await onRefresh()
      }

      const endpoint = await connectToHost(target.ip, target.port)
      showNotice('success', `连接成功：${endpoint.ip}:${endpoint.port}`)
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      showNotice('error', normalizeUiErrorMessage(errorMsg, target.ip, target.port))
      await onRefresh()
