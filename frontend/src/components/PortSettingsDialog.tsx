import { useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

interface SettingsModel {
  scan_concurrency: number
  scan_timeout: number
  allowed_ports: number[]
  allowed_origins: string[]
  local_proxy_ports: number[]
}

interface PortProcessInfo {
  pid: number
  name: string
  command?: string
  path?: string
}

interface OccupiedPortInfo {
  port: number
  error: string
  processes: PortProcessInfo[]
}

interface ProxyInfo {
  port: number
  baseUrl: string
  demoUrl: string
  configuredPorts: number[]
  activePorts: number[]
  occupiedPorts: OccupiedPortInfo[]
  ready: boolean
  lastError?: string | null
}

interface ProxyRuntimeSnapshot {
  configuredPorts: number[]
  activePorts: number[]
  occupiedPorts: OccupiedPortInfo[]
  ready: boolean
  lastError?: string | null
}

interface PortSettingsDialogProps {
  onClose: () => void
  onApplied?: () => void
}

export default function PortSettingsDialog({ onClose, onApplied }: PortSettingsDialogProps) {
  const [settings, setSettings] = useState<SettingsModel>({
    scan_concurrency: 24,
    scan_timeout: 600,
    allowed_ports: [8000],
    allowed_origins: ['localhost', '127.0.0.1'],
    local_proxy_ports: [8000, 18000],
  })
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [proxyInfo, setProxyInfo] = useState<ProxyInfo | null>(null)
  const [killingKey, setKillingKey] = useState<string | null>(null)
  const [showOccupiedDetails, setShowOccupiedDetails] = useState(false)

  useEffect(() => {
    void loadAll()
  }, [])

  useEffect(() => {
    if ((proxyInfo?.occupiedPorts?.length ?? 0) === 0) {
      setShowOccupiedDetails(false)
    }
  }, [proxyInfo?.occupiedPorts?.length])

  const portStatusItems = useMemo(() => {
    const configuredPorts = proxyInfo?.configuredPorts?.length ? proxyInfo.configuredPorts : settings.local_proxy_ports
    const activeSet = new Set(proxyInfo?.activePorts ?? [])
    const occupiedSet = new Set((proxyInfo?.occupiedPorts ?? []).map((item) => item.port))

    return configuredPorts.map((port) => {
      if (activeSet.has(port)) {
        return {
          port,
          label: '已监听',
          className: 'border-emerald-200 bg-emerald-50 text-emerald-700',
          dotClassName: 'bg-emerald-500',
        }
      }
      if (occupiedSet.has(port)) {
        return {
          port,
          label: '被占用',
          className: 'border-rose-200 bg-rose-50 text-rose-700',
          dotClassName: 'bg-rose-500',
        }
      }
      return {
        port,
        label: '未监听',
        className: 'border-slate-200 bg-slate-50 text-slate-600',
        dotClassName: 'bg-slate-400',
      }
    })
  }, [proxyInfo, settings.local_proxy_ports])

  const showMessage = (type: 'success' | 'error', text: string) => {
    setMessage({ type, text })
    window.setTimeout(() => setMessage(null), 3500)
  }

  const loadAll = async () => {
    setIsLoading(true)
    try {
      const [savedSettings, savedProxyInfo] = await Promise.all([
        invoke<SettingsModel>('get_settings'),
        invoke<ProxyInfo>('get_proxy_info'),
      ])
      setSettings(savedSettings)
      setProxyInfo(savedProxyInfo)
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      showMessage('error', `加载设置失败: ${errorMsg}`)
    } finally {
      setIsLoading(false)
    }
  }

  const handleSave = async () => {
    setIsSaving(true)
    try {
      const nextPorts = settings.local_proxy_ports
      if (nextPorts.length !== 2 || nextPorts.some((port) => !Number.isFinite(port) || port <= 0 || port > 65535)) {
        throw new Error('本地监听端口必须为两个合法端口号')
      }
      if (nextPorts[0] === nextPorts[1]) {
        throw new Error('本地监听端口不能重复')
      }

      await invoke('update_settings', { settings })
      const latest = await invoke<ProxyInfo>('get_proxy_info')
      setProxyInfo(latest)
      showMessage('success', '端口已更新并开始监听')
      onApplied?.()
      onClose()
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      showMessage('error', `保存失败: ${errorMsg}`)
    } finally {
      setIsSaving(false)
    }
  }

  const setLocalProxyPort = (index: number, raw: string) => {
    const value = Number.parseInt(raw, 10)
    setSettings((prev) => {
      const ports = [...prev.local_proxy_ports]
      ports[index] = Number.isFinite(value) ? value : 0
      return {
        ...prev,
        local_proxy_ports: ports,
      }
    })
  }

  const handleKillProcess = async (port: number, process: PortProcessInfo) => {
    const commandLine = process.command ? `命令: ${process.command}\n` : ''
    const confirm = window.confirm(
      `确认结束占用进程？\n端口: ${port}\n进程: ${process.name} (PID ${process.pid})\n${commandLine}将先尝试优雅终止，超时后强制终止。`,
    )
    if (!confirm) {
      return
    }

    const key = `${port}:${process.pid}`
    setKillingKey(key)
    try {
      const runtime = await invoke<ProxyRuntimeSnapshot>('kill_port_process', {
        port,
        pid: process.pid,
      })
      const latest = await invoke<ProxyInfo>('get_proxy_info')
      setProxyInfo(latest)
      if (runtime.ready) {
        showMessage('success', `端口处理完成，当前监听端口: ${runtime.activePorts.join(', ')}`)
      } else {
        showMessage('error', runtime.lastError || '端口处理完成，但代理仍未就绪')
      }
      onApplied?.()
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      showMessage('error', `终止进程失败: ${errorMsg}`)
    } finally {
      setKillingKey(null)
    }
  }

  if (isLoading) {
    return (
      <div className="flex min-h-[220px] items-center justify-center bg-[color:var(--bridge-surface)]">
        <p className="text-muted-foreground">加载中...</p>
      </div>
    )
  }

  return (
    <div className="flex max-h-[85dvh] min-h-0 flex-col bg-[color:var(--bridge-surface)]">
      <div className="flex items-center justify-between border-b border-[color:var(--bridge-border)] px-6 py-4">
        <h2 className="text-xl font-bold tracking-tight text-slate-900">端口设置</h2>
        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          className="h-9 w-9 rounded-lg text-slate-500 hover:bg-[color:var(--bridge-panel)] hover:text-slate-700"
          aria-label="关闭端口设置"
        >
          ×
        </Button>
      </div>

      <div className="bridge-scrollbar flex-1 overflow-y-auto px-6 py-5">
        {message && (
          <div
            className={`mb-4 rounded-xl border px-3 py-2.5 text-sm ${
              message.type === 'success'
                ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                : 'border-rose-200 bg-rose-50 text-rose-700'
            }`}
          >
            <div className="flex items-start gap-2">
              <span
                className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${
                  message.type === 'success' ? 'bg-emerald-500' : 'bg-rose-500'
                }`}
              />
              <span>{message.text}</span>
            </div>
          </div>
        )}

        <section className="rounded-2xl border border-[color:var(--bridge-border)]/85 bg-[color:var(--bridge-panel)]/40 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.55)]">
          <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="local-port-1" className="text-xs font-semibold text-slate-600">
                端口 A
              </Label>
              <Input
                id="local-port-1"
                type="number"
                min="1"
                max="65535"
                value={settings.local_proxy_ports[0] ?? ''}
                onChange={(event) => setLocalProxyPort(0, event.target.value)}
                className="h-11 rounded-xl border-[color:var(--bridge-border)] bg-white font-mono text-[15px]"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="local-port-2" className="text-xs font-semibold text-slate-600">
                端口 B
              </Label>
              <Input
                id="local-port-2"
                type="number"
                min="1"
                max="65535"
                value={settings.local_proxy_ports[1] ?? ''}
                onChange={(event) => setLocalProxyPort(1, event.target.value)}
                className="h-11 rounded-xl border-[color:var(--bridge-border)] bg-white font-mono text-[15px]"
              />
            </div>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            {portStatusItems.map((item) => (
              <span
                key={item.port}
                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold ${item.className}`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${item.dotClassName}`} />
                <span className="font-mono">{item.port}</span>
                <span>{item.label}</span>
              </span>
            ))}
          </div>
        </section>

        {proxyInfo?.occupiedPorts?.length ? (
          <section className="mt-4 rounded-2xl border border-rose-200 bg-rose-50/35">
            <div className="flex items-center justify-between gap-3 border-b border-rose-200 px-4 py-3">
              <div className="inline-flex items-center gap-2 text-sm font-semibold text-rose-800">
                <span className="h-2 w-2 rounded-full bg-rose-500" />
                <span>端口占用</span>
                <span className="rounded-full bg-white/85 px-2 py-0.5 text-[11px]">{proxyInfo.occupiedPorts.length}</span>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setShowOccupiedDetails((prev) => !prev)}
                className="h-8 border-rose-300 bg-white text-rose-700 hover:bg-rose-100"
              >
                {showOccupiedDetails ? '收起详情' : '查看详情'}
              </Button>
            </div>

            {showOccupiedDetails ? (
              <div className="space-y-3 px-4 py-3">
                {proxyInfo.occupiedPorts.map((occupied) => (
                  <div key={occupied.port} className="rounded-xl border border-rose-200/85 bg-white p-3">
                    <div className="text-sm font-semibold text-rose-800">端口 {occupied.port} 被占用</div>
                    <p className="mt-1 text-xs text-rose-700 break-all">{occupied.error}</p>
                    {occupied.processes.length === 0 ? (
                      <p className="mt-2 text-xs text-rose-700">未获取到占用进程信息，请手动处理后重试。</p>
                    ) : (
                      <div className="mt-2 space-y-2">
                        {occupied.processes.map((process) => {
                          const key = `${occupied.port}:${process.pid}`
                          return (
                            <div key={key} className="rounded-lg border border-rose-200/85 bg-rose-50/35 px-2.5 py-2 text-xs text-slate-700">
                              <div className="flex items-center justify-between gap-2">
                                <div className="min-w-0">
                                  <p className="font-semibold truncate">
                                    {process.name} (PID {process.pid})
                                  </p>
                                  {process.command ? <p className="text-slate-500 break-all">{process.command}</p> : null}
                                </div>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => void handleKillProcess(occupied.port, process)}
                                  disabled={killingKey === key || isSaving}
                                  className="h-7 shrink-0 border-rose-300 bg-rose-50 text-rose-700 hover:bg-rose-100"
                                >
                                  {killingKey === key ? '处理中...' : '结束并重试'}
                                </Button>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="px-4 py-3 text-xs text-rose-700">检测到端口占用，可展开查看并处理。</p>
            )}
          </section>
        ) : null}
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-[color:var(--bridge-border)] bg-white px-6 py-4">
        <Button variant="outline" onClick={onClose} disabled={isSaving}>
          取消
        </Button>
        <Button onClick={handleSave} disabled={isSaving}>
          {isSaving ? '应用中...' : '应用并监听'}
        </Button>
      </div>
    </div>
  )
}
