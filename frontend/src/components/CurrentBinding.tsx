import { useState, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-shell'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

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
  status: string
}

interface Props {
  status: StatusResponse | null
  onRefresh: () => void
}

export default function CurrentBinding({ status, onRefresh }: Props) {
  const [printers, setPrinters] = useState<string[]>([])
  const [selectedPrinter, setSelectedPrinter] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error', text: string } | null>(null)

  // Load printers when component mounts or host changes
  useEffect(() => {
    if (status?.boundHost) {
      loadPrinters()
    }
  }, [status])

  const loadPrinters = async () => {
    setLoading(true)
    try {
      const result = await invoke<string[]>('get_printers')
      setPrinters(result || [])
      if (result && result.length > 0) {
        setSelectedPrinter(result[0])
      }
    } catch (err) {
      console.error('Failed to load printers:', err)
      setPrinters([])
    } finally {
      setLoading(false)
    }
  }

  const showMessage = (type: 'success' | 'error', text: string) => {
    setMessage({ type, text })
    setTimeout(() => setMessage(null), 3000)
  }

  const handleTestConnection = async () => {
    if (!status?.boundHost) return
    setLoading(true)
    try {
      await onRefresh()
      showMessage('success', '连接正常')
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      showMessage('error', '连接失败: ' + errorMsg)
    } finally {
      setLoading(false)
    }
  }

  const handleRefreshPrinters = async () => {
    await loadPrinters()
    showMessage('success', `获取到 ${printers.length} 个打印机`)
  }

  const handleTestPrint = async () => {
    setLoading(true)
    try {
      await invoke('test_print', {
        printer: selectedPrinter || null
      })
      showMessage('success', '打印任务已发送')
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      showMessage('error', '打印失败: ' + errorMsg)
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
      onRefresh()
      showMessage('success', '已解除绑定')
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      showMessage('error', '解绑失败: ' + errorMsg)
    } finally {
      setLoading(false)
    }
  }

  const handleOpenDemo = async () => {
    try {
      await open('http://localhost:8000/demo/index.html')
    } catch (err) {
      showMessage('error', '无法打开 Demo 页面')
    }
  }

  if (!status?.boundHost) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>当前绑定</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-center py-8">
            当前未绑定任何主机。请先在"主机发现"页面扫描并选择一个主机。
          </p>
        </CardContent>
      </Card>
    )
  }

  const host = status.boundHost

  return (
    <div className="space-y-6">
      {message && (
        <div className={`px-4 py-3 rounded border ${
          message.type === 'success'
            ? 'bg-green-50 border-green-200 text-green-700'
            : 'bg-red-50 border-red-200 text-red-700'
        }`}>
          {message.text}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>绑定信息</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <span className="text-sm text-muted-foreground">IP 地址:</span>
              <p className="font-medium">{host.ip}</p>
            </div>
            <div>
              <span className="text-sm text-muted-foreground">端口:</span>
              <p className="font-medium">{host.port}</p>
            </div>
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
            {host.rtt && (
              <div>
                <span className="text-sm text-muted-foreground">延迟:</span>
                <p className="font-medium">{host.rtt}ms</p>
              </div>
            )}
            <div>
              <span className="text-sm text-muted-foreground">状态:</span>
              <p className="font-medium text-green-600">
                {status.status === 'online' ? '● 在线' : '● 离线'}
              </p>
            </div>
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
            <Button onClick={handleTestConnection} disabled={loading}>
              测试连接
            </Button>
            <Button onClick={handleRefreshPrinters} disabled={loading}>
              获取打印机列表
            </Button>
          </div>

          {printers.length > 0 && (
            <div>
              <label className="text-sm text-muted-foreground">选择打印机:</label>
              <select
                className="w-full mt-1 px-3 py-2 border rounded-md"
                value={selectedPrinter}
                onChange={(e) => setSelectedPrinter(e.target.value)}
              >
                {printers.map(printer => (
                  <option key={printer} value={printer}>{printer}</option>
                ))}
              </select>
            </div>
          )}

          <div className="flex gap-2">
            <Button onClick={handleTestPrint} disabled={loading || !selectedPrinter}>
              发送测试打印
            </Button>
            <Button onClick={handleOpenDemo} variant="outline" disabled={loading}>
              打开 Demo 页
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
