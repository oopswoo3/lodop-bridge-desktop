import { useState, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Label } from '@/components/ui/label'

interface HostInfo {
  ip: string
  port: number
  hostname?: string
  os?: string
  version?: string
  rtt?: number
  timestamp: number
}

interface ProgressData {
  scanned: number
  total: number
  found: number
}

interface Props {
  scanProgress: ProgressData | null
  onScanComplete?: () => void
}

export default function HostDiscovery({ scanProgress, onScanComplete }: Props) {
  const [isScanning, setIsScanning] = useState(false)
  const [hosts, setHosts] = useState<HostInfo[]>([])
  const [progress, setProgress] = useState<ProgressData>({ scanned: 0, total: 0, found: 0 })
  const [manualIP, setManualIP] = useState('')
  const [manualPort, setManualPort] = useState('8000')
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [hostNotes, setHostNotes] = useState<Record<string, string>>({})
  const [editingNote, setEditingNote] = useState<string | null>(null)
  const [noteInput, setNoteInput] = useState('')

  useEffect(() => {
    loadResults()
    loadHostNotes()
  }, [])

  // Listen for host-found events to update list in real-time
  useEffect(() => {
    const unlisten = listen<{ host: HostInfo }>('host-found', (event) => {
      setHosts(prev => {
        const key = `${event.payload.host.ip}:${event.payload.host.port}`
        const exists = prev.some(h => `${h.ip}:${h.port}` === key)
        if (!exists) {
          return [...prev, event.payload.host]
        }
        return prev
      })
    })

    return () => {
      unlisten.then(fn => fn())
    }
  }, [])

  // Update progress when parent provides new progress data
  useEffect(() => {
    if (scanProgress) {
      setProgress(scanProgress)
      setIsScanning(scanProgress.scanned < scanProgress.total)
    }
  }, [scanProgress])

  const loadResults = async () => {
    try {
      const results = await invoke<HostInfo[]>('get_scan_results')
      setHosts(results)
    } catch (err) {
      console.error('Failed to load scan results:', err)
    }
  }

  const loadHostNotes = async () => {
    try {
      const notes = await invoke<Record<string, string>>('get_all_host_notes')
      setHostNotes(notes || {})
    } catch (err) {
      console.error('Failed to load host notes:', err)
    }
  }

  const getHostNote = (ip: string, port: number) => {
    const key = `${ip}:${port}`
    return hostNotes[key] || ''
  }

  const handleEditNote = (host: HostInfo) => {
    const key = `${host.ip}:${host.port}`
    setEditingNote(key)
    setNoteInput(getHostNote(host.ip, host.port))
  }

  const handleSaveNote = async (host: HostInfo) => {
    try {
      await invoke('set_host_note', {
        ip: host.ip,
        port: host.port,
        note: noteInput
      })
      const key = `${host.ip}:${host.port}`
      setHostNotes(prev => ({
        ...prev,
        [key]: noteInput.trim()
      }))
      setEditingNote(null)
      setNoteInput('')
      setSuccess('备注已保存')
      setTimeout(() => setSuccess(null), 3000)
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      setError('保存备注失败: ' + errorMsg)
      setTimeout(() => setError(null), 3000)
    }
  }

  const handleCancelEdit = () => {
    setEditingNote(null)
    setNoteInput('')
  }

  const handleStartScan = async () => {
    setIsScanning(true)
    setError(null)
    setSuccess(null)
    setHosts([])
    setProgress({ scanned: 0, total: 0, found: 0 })

    try {
      await invoke('start_scan')
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      setError(errorMsg || '扫描失败')
      setIsScanning(false)
    }
  }

  const handleStopScan = async () => {
    try {
      await invoke('stop_scan')
      setIsScanning(false)
      onScanComplete?.()
    } catch (err) {
      console.error('Failed to stop scan:', err)
    }
  }

  const handleRescan = async () => {
    setHosts([])
    await handleStartScan()
  }

  const handleAddHost = async () => {
    if (!manualIP || !manualPort) {
      setError('请输入 IP 和端口')
      setTimeout(() => setError(null), 3000)
      return
    }

    setError(null)
    setSuccess(null)

    try {
      const host = await invoke<HostInfo>('add_host', {
        ip: manualIP,
        port: parseInt(manualPort)
      })
      if (host) {
        setHosts(prev => {
          const key = `${host.ip}:${host.port}`
          const exists = prev.some(h => `${h.ip}:${h.port}` === key)
          if (!exists) {
            return [...prev, host]
          }
          return prev
        })
        setSuccess(`成功添加主机 ${manualIP}:${manualPort}`)
        setManualIP('')
        setTimeout(() => setSuccess(null), 3000)
      } else {
        setError('无法连接到该主机')
        setTimeout(() => setError(null), 3000)
      }
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      setError(errorMsg || '添加主机失败')
      setTimeout(() => setError(null), 3000)
    }
  }

  const handleSelectHost = async (host: HostInfo) => {
    setError(null)
    setSuccess(null)

    try {
      await invoke('bind_host', {
        ip: host.ip,
        port: host.port
      })
      setSuccess(`成功绑定到 ${host.ip}:${host.port}`)
      setTimeout(() => {
        setSuccess(null)
        onScanComplete?.()
      }, 1500)
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      setError(errorMsg || '绑定失败')
      setTimeout(() => setError(null), 3000)
    }
  }

  const filteredHosts = hosts.filter(host => {
    if (!searchQuery.trim()) return true
    const query = searchQuery.toLowerCase()
    const ip = host.ip.toLowerCase()
    const hostname = (host.hostname || '').toLowerCase()
    const os = (host.os || '').toLowerCase()
    const version = (host.version || '').toLowerCase()
    const port = host.port
    const note = getHostNote(host.ip, port).toLowerCase()

    return ip.includes(query) ||
      hostname.includes(query) ||
      os.includes(query) ||
      version.includes(query) ||
      String(port).includes(query) ||
      note.includes(query)
  })

  return (
    <div className="space-y-6">
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">
          {error}
        </div>
      )}
      {success && (
        <div className="bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded">
          {success}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>局域网扫描</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-2">
            <Button onClick={handleStartScan} disabled={isScanning}>
              {isScanning ? '扫描中...' : '开始扫描'}
            </Button>
            <Button variant="outline" onClick={handleStopScan} disabled={!isScanning}>
              停止扫描
            </Button>
            <Button variant="outline" onClick={handleRescan} disabled={isScanning}>
              重新扫描
            </Button>
          </div>

          {progress.total > 0 && (
            <div className="space-y-2">
              <Progress value={(progress.scanned / progress.total) * 100} />
              <div className="text-sm text-muted-foreground">
                已扫描: {progress.scanned} / {progress.total} | 发现: {progress.found}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>手动添加主机</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex gap-2">
            <div className="flex-2 flex-1">
              <Label htmlFor="manual-ip" className="sr-only">IP 地址</Label>
              <Input
                id="manual-ip"
                placeholder="IP 地址"
                value={manualIP}
                onChange={(e) => setManualIP(e.target.value)}
              />
            </div>
            <div className="flex-1 w-32">
              <Label htmlFor="manual-port" className="sr-only">端口</Label>
              <Input
                id="manual-port"
                placeholder="端口"
                value={manualPort}
                onChange={(e) => setManualPort(e.target.value)}
              />
            </div>
            <Button onClick={handleAddHost}>
              添加
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex justify-between items-center">
            <CardTitle>发现的主机 ({hosts.length})</CardTitle>
            <Input
              placeholder="搜索 IP、主机名、备注或系统信息..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-64"
            />
          </div>
        </CardHeader>
        <CardContent>
          {filteredHosts.length === 0 ? (
            <p className="text-muted-foreground py-8 text-center">
              {searchQuery ? '没有找到匹配的主机' : '暂无发现的主机'}
            </p>
          ) : (
            <ul className="space-y-3">
              {filteredHosts.map((host) => {
                const key = `${host.ip}:${host.port}`
                const note = getHostNote(host.ip, host.port)
                const isEditing = editingNote === key

                return (
                  <li key={key} className="border rounded-lg p-4 flex items-start gap-4">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-2 flex-wrap">
                        <span className="font-semibold">{host.ip}</span>
                        {host.hostname && (
                          <span className="bg-blue-100 text-blue-700 px-2 py-0.5 rounded text-sm">
                            {host.hostname}
                          </span>
                        )}
                        {note && !isEditing && (
                          <span className="bg-yellow-100 text-yellow-700 px-2 py-0.5 rounded text-sm">
                            📝 {note}
                          </span>
                        )}
                      </div>

                      {isEditing ? (
                        <div className="mb-2 space-y-2">
                          <Input
                            placeholder="输入备注..."
                            value={noteInput}
                            onChange={(e) => setNoteInput(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                handleSaveNote(host)
                              } else if (e.key === 'Escape') {
                                handleCancelEdit()
                              }
                            }}
                            autoFocus
                          />
                          <div className="flex gap-2">
                            <Button
                              size="sm"
                              onClick={() => handleSaveNote(host)}
                            >
                              保存
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={handleCancelEdit}
                            >
                              取消
                            </Button>
                          </div>
                        </div>
                      ) : null}

                      <div className="text-sm text-muted-foreground space-y-1">
                        <div>
                          <span className="font-medium">端口:</span> {host.port} |
                          <span className="font-medium"> 延迟:</span> {host.rtt}ms
                        </div>
                        {(host.os || host.version) && (
                          <div className="text-xs">
                            {host.os && <span>系统: {host.os}</span>}
                            {host.os && host.version && <span> | </span>}
                            {host.version && <span>版本: {host.version}</span>}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleEditNote(host)}
                        title="编辑备注"
                      >
                        {note ? '✏️' : '📝'}
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => handleSelectHost(host)}
                      >
                        选择
                      </Button>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
