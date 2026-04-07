import { useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-shell'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import EndpointDisplay from '@/components/EndpointDisplay'
import HostStatusPill from '@/components/HostStatusPill'
import { Input } from '@/components/ui/input'
import { fetchPrinters, getProxyInfo, runTestPrint, type ProxyInfo } from '@/lib/clodop'

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

interface Props {
  status: StatusResponse | null
  onRefresh: () => void
}

const INVALID_PRINTER_LIST = [
  '导出为WPS PDF',
  'OneNote for Windows 10',
  'Microsoft XPS Document Writer',
  'Microsoft Print to PDF',
  'Fax',
]
const PRINTER_CACHE_KEY = 'print'

function getSavedPrinter(): string | null {
  try {
    const raw = localStorage.getItem(PRINTER_CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { printer?: string }
    return parsed.printer ?? null
  } catch {
    return null
  }
}

function savePrinter(printer: string | null): void {
  try {
    localStorage.setItem(PRINTER_CACHE_KEY, JSON.stringify({ printer }))
  } catch {
    // ignore localStorage failure
  }
}

export default function CurrentBinding({ status, onRefresh }: Props) {
  const [proxyInfo, setProxyInfo] = useState<ProxyInfo | null>(null)
  const [printers, setPrinters] = useState<string[]>([])
  const [selectedPrinter, setSelectedPrinter] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const [loadingPrinters, setLoadingPrinters] = useState(false)
  const [loadingNote, setLoadingNote] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [hostNote, setHostNote] = useState('')
  const [isEditingNote, setIsEditingNote] = useState(false)
  const [noteInput, setNoteInput] = useState('')

  const validPrinters = useMemo(
    () => printers.filter((printer) => !INVALID_PRINTER_LIST.includes(printer)),
    [printers],
  )

  useEffect(() => {
    void loadProxyInfo()
  }, [])

  useEffect(() => {
    if (status?.boundHost && proxyInfo) {
      void loadPrinters()
      void loadHostNote()
    } else {
      setPrinters([])
      setSelectedPrinter('')
      setHostNote('')
      setNoteInput('')
      setIsEditingNote(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.boundHost?.ip, status?.boundHost?.port, proxyInfo?.baseUrl])

  useEffect(() => {
    if (validPrinters.length === 0) {
      setSelectedPrinter('')
      return
    }

    const saved = getSavedPrinter()
    if (saved && validPrinters.includes(saved)) {
      setSelectedPrinter(saved)
      return
    }

    setSelectedPrinter(validPrinters[0])
    savePrinter(validPrinters[0])
  }, [validPrinters])

  const showMessage = (type: 'success' | 'error', text: string) => {
    setMessage({ type, text })
    setTimeout(() => setMessage(null), 3000)
  }

  const loadProxyInfo = async () => {
    try {
      const info = await getProxyInfo()
      setProxyInfo(info)
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      showMessage('error', `获取代理信息失败: ${errorMsg}`)
    }
  }

  const loadPrinters = async (): Promise<number> => {
    if (!proxyInfo) return 0

    setLoadingPrinters(true)
    try {
      const loaded = await fetchPrinters(proxyInfo.baseUrl)
      setPrinters(loaded)
      return loaded.filter((printer) => !INVALID_PRINTER_LIST.includes(printer)).length
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      showMessage('error', `获取打印机列表失败: ${errorMsg}`)
      setPrinters([])
      return 0
    } finally {
      setLoadingPrinters(false)
    }
  }

  const loadHostNote = async () => {
    if (!status?.boundHost) return
    try {
      const directNote = await invoke<string | null>('get_host_note', {
        ip: status.boundHost.ip,
        port: status.boundHost.port,
      })

      let noteValue = directNote ?? ''
      if (!noteValue) {
        const allNotes = await invoke<Record<string, string>>('get_all_host_notes')
        const prefix = `${status.boundHost.ip}:`
        const matched = Object.entries(allNotes ?? {}).find(([key, value]) => {
          return key.startsWith(prefix) && Boolean(value?.trim())
        })
        if (matched) {
          noteValue = matched[1]
        }
      }

      setHostNote(noteValue)
      setNoteInput(noteValue)
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      showMessage('error', `加载备注失败: ${errorMsg}`)
    }
  }

  const handleSaveNote = async () => {
    if (!status?.boundHost) return
    setLoadingNote(true)
    try {
      await invoke('set_host_note', {
        ip: status.boundHost.ip,
        port: status.boundHost.port,
        note: noteInput,
      })
      const savedNote = noteInput.trim()
      setHostNote(savedNote)
      setIsEditingNote(false)
      showMessage('success', '备注已保存')
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      showMessage('error', `保存备注失败: ${errorMsg}`)
    } finally {
      setLoadingNote(false)
    }
  }

  const handleTestConnection = async () => {
    if (!status?.boundHost) return
    setLoading(true)
    try {
      const latest = await invoke<StatusResponse>('get_status')
      await onRefresh()
      if (latest.status.online) {
        showMessage('success', '连接正常')
      } else {
        showMessage('error', latest.status.error || '目标主机离线')
      }
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      showMessage('error', `连接检测失败: ${errorMsg}`)
    } finally {
      setLoading(false)
    }
  }

  const handleRefreshPrinters = async () => {
    const count = await loadPrinters()
    showMessage('success', `获取到 ${count} 个有效打印机`)
  }

  const handleTestPrint = async () => {
    if (!proxyInfo) {
      showMessage('error', '代理信息不可用，请重试')
      return
    }

    setLoading(true)
    try {
      await runTestPrint(proxyInfo.baseUrl, selectedPrinter || null)
      showMessage('success', `打印任务已发送${selectedPrinter ? `（${selectedPrinter}）` : ''}`)
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      showMessage('error', `打印失败: ${errorMsg}`)
    } finally {
      setLoading(false)
    }
  }

  const handleUnbind = async () => {
    setLoading(true)
    try {
      await invoke('unbind_host')
      setPrinters([])
      setSelectedPrinter('')
      setHostNote('')
      setIsEditingNote(false)
      onRefresh()
      showMessage('success', '已解除绑定')
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      showMessage('error', `解绑失败: ${errorMsg}`)
    } finally {
      setLoading(false)
    }
  }

  const handleOpenDemo = async () => {
    if (!proxyInfo) {
      showMessage('error', '代理信息不可用，请重试')
      return
    }
    try {
      await open(proxyInfo.demoUrl)
    } catch {
      showMessage('error', '无法打开 Demo 页面')
    }
  }

  const handlePrinterChange = (value: string) => {
    setSelectedPrinter(value)
    savePrinter(value || null)
  }

  if (!status?.boundHost) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>当前绑定</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-center py-8">
            当前未绑定任何主机。请先在“快速连接”页输入主机并完成诊断绑定。
          </p>
        </CardContent>
      </Card>
    )
  }

  const host = status.boundHost
  const isOnline = status.status.online

  return (
    <div className="space-y-6">
      {message && (
        <div
          className={`px-4 py-3 rounded border ${
            message.type === 'success'
              ? 'bg-green-50 border-green-200 text-green-700'
              : 'bg-red-50 border-red-200 text-red-700'
          }`}
        >
          {message.text}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>绑定信息</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <EndpointDisplay
            endpoint={{
              ip: host.ip,
              port: host.port,
              status: isOnline ? 'online' : 'offline',
              rtt: host.rtt,
              copyValue: `${host.ip}:${host.port}`,
            }}
            showCopy
            emphasize="primary"
            className="w-full"
          />

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {host.hostname && (
              <div>
                <span className="text-sm text-muted-foreground">主机名:</span>
                <p className="font-medium">{host.hostname}</p>
              </div>
            )}
            {host.os && (
              <div>
                <span className="text-sm text-muted-foreground">操作系统:</span>
                <p className="font-medium">{host.os}</p>
              </div>
            )}
            {host.version && (
              <div>
                <span className="text-sm text-muted-foreground">版本:</span>
                <p className="font-medium">{host.version}</p>
              </div>
            )}
            {host.rtt !== undefined && (
              <div>
                <span className="text-sm text-muted-foreground">延迟:</span>
                <p className="font-medium">{host.rtt}ms</p>
              </div>
            )}
            <div>
              <span className="text-sm text-muted-foreground">连接状态:</span>
              <div className="mt-1">
                <HostStatusPill status={isOnline ? 'online' : 'offline'} showPulse={isOnline} />
              </div>
              {!isOnline && status.status.error && (
                <p className="text-xs text-red-500 mt-1">{status.status.error}</p>
              )}
            </div>
          </div>

          <div className="pt-2">
            <span className="text-sm text-muted-foreground">主机备注:</span>
            {isEditingNote ? (
              <div className="mt-2 space-y-2">
                <Input
                  value={noteInput}
                  onChange={(event) => setNoteInput(event.target.value)}
                  placeholder="输入备注..."
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      void handleSaveNote()
                    } else if (event.key === 'Escape') {
                      setIsEditingNote(false)
                      setNoteInput(hostNote)
                    }
                  }}
                />
                <div className="flex gap-2">
                  <Button onClick={() => void handleSaveNote()} disabled={loadingNote}>
                    保存备注
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setIsEditingNote(false)
                      setNoteInput(hostNote)
                    }}
                    disabled={loadingNote}
                  >
                    取消
                  </Button>
                </div>
              </div>
            ) : (
              <div className="mt-2 flex items-center gap-2">
                <p className="font-medium">{hostNote || '暂无备注'}</p>
                <Button variant="outline" size="sm" onClick={() => setIsEditingNote(true)}>
                  备注
                </Button>
              </div>
            )}
          </div>

          <div className="flex gap-2 pt-4">
            <Button onClick={onRefresh} variant="outline" disabled={loading}>
              刷新状态
            </Button>
            <Button onClick={handleUnbind} variant="destructive" disabled={loading}>
              解除绑定
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>打印测试</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-2">
            <Button onClick={() => void handleTestConnection()} disabled={loading}>
              测试连接
            </Button>
            <Button
              onClick={() => void handleRefreshPrinters()}
              disabled={loading || loadingPrinters || !isOnline}
            >
              {loadingPrinters ? '获取中...' : '获取打印机列表'}
            </Button>
          </div>

          {validPrinters.length > 0 && (
            <div>
              <label className="text-sm text-muted-foreground">选择打印机:</label>
              <select
                className="w-full mt-1 px-3 py-2 border rounded-md"
                value={selectedPrinter}
                onChange={(event) => handlePrinterChange(event.target.value)}
              >
                {validPrinters.map((printer) => (
                  <option key={printer} value={printer}>
                    {printer}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="flex gap-2">
            <Button
              onClick={() => void handleTestPrint()}
              disabled={loading || !isOnline || validPrinters.length === 0}
            >
              发送测试打印
            </Button>
            <Button onClick={() => void handleOpenDemo()} variant="outline" disabled={loading}>
              打开 Demo 页
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
