import { useState, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

interface Settings {
  scan_concurrency: number
  scan_timeout: number
  allowed_ports: number[]
  allowed_origins: string[]
}

export default function Settings() {
  const [settings, setSettings] = useState<Settings>({
    scan_concurrency: 64,
    scan_timeout: 800,
    allowed_ports: [8000, 18000],
    allowed_origins: ['localhost', '127.0.0.1']
  })
  const [newPort, setNewPort] = useState('')
  const [newOrigin, setNewOrigin] = useState('')
  const [message, setMessage] = useState<{ type: 'success' | 'error', text: string } | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    loadSettings()
  }, [])

  const loadSettings = async () => {
    setIsLoading(true)
    try {
      const result = await invoke<Settings>('get_settings')
      setSettings(result)
    } catch (err) {
      console.error('Failed to load settings:', err)
    } finally {
      setIsLoading(false)
    }
  }

  const showMessage = (type: 'success' | 'error', text: string) => {
    setMessage({ type, text })
    setTimeout(() => setMessage(null), 3000)
  }

  const handleSave = async () => {
    try {
      await invoke('update_settings', { settings })
      showMessage('success', '设置已保存')
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      showMessage('error', '保存失败: ' + errorMsg)
    }
  }

  const handleAddPort = () => {
    const port = parseInt(newPort)
    if (port && port > 0 && port < 65536 && !settings.allowed_ports.includes(port)) {
      setSettings(prev => ({
        ...prev,
        allowed_ports: [...prev.allowed_ports, port].sort((a, b) => a - b)
      }))
      setNewPort('')
    }
  }

  const handleRemovePort = (port: number) => {
    if (settings.allowed_ports.length <= 1) {
      showMessage('error', '至少需要保留一个端口')
      return
    }
    setSettings(prev => ({
      ...prev,
      allowed_ports: prev.allowed_ports.filter(p => p !== port)
    }))
  }

  const handleAddOrigin = () => {
    const origin = newOrigin.trim()
    if (origin && !settings.allowed_origins.includes(origin)) {
      setSettings(prev => ({
        ...prev,
        allowed_origins: [...prev.allowed_origins, origin]
      }))
      setNewOrigin('')
    }
  }

  const handleRemoveOrigin = (origin: string) => {
    if (settings.allowed_origins.length <= 1) {
      showMessage('error', '至少需要保留一个 Origin')
      return
    }
    setSettings(prev => ({
      ...prev,
      allowed_origins: prev.allowed_origins.filter(o => o !== origin)
    }))
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-muted-foreground">加载设置中...</p>
      </div>
    )
  }

  return (
    <div className="space-y-6 max-w-2xl">
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
          <CardTitle>扫描设置</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label htmlFor="concurrency">并发数</Label>
            <Input
              id="concurrency"
              type="number"
              value={settings.scan_concurrency}
              onChange={(e) => setSettings(prev => ({
                ...prev,
                scan_concurrency: parseInt(e.target.value) || 1
              }))}
              min="1"
              max="512"
            />
            <p className="text-sm text-muted-foreground mt-1">
              同时扫描的 IP 数量 (1-512)，默认 64
            </p>
          </div>

          <div>
            <Label htmlFor="timeout">超时时间 (ms)</Label>
            <Input
              id="timeout"
              type="number"
              value={settings.scan_timeout}
              onChange={(e) => setSettings(prev => ({
                ...prev,
                scan_timeout: parseInt(e.target.value) || 100
              }))}
              min="100"
              max="10000"
            />
            <p className="text-sm text-muted-foreground mt-1">
              单个端口探测的超时时间 (100-10000ms)，默认 800ms
            </p>
          </div>

          <div>
            <Label>允许的端口</Label>
            <div className="flex gap-2 mt-1">
              <Input
                placeholder="输入端口号 (1-65535)"
                value={newPort}
                onChange={(e) => setNewPort(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleAddPort()}
              />
              <Button onClick={handleAddPort}>添加</Button>
            </div>
            <div className="flex flex-wrap gap-2 mt-2">
              {settings.allowed_ports.map(port => (
                <span
                  key={port}
                  className="bg-secondary px-2 py-1 rounded flex items-center gap-1"
                >
                  {port}
                  <button
                    onClick={() => handleRemovePort(port)}
                    className="text-muted-foreground hover:text-destructive ml-1"
                    type="button"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
            <p className="text-sm text-muted-foreground mt-2">
              扫描时检查的端口号，默认包含 8000 和 18000
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>安全设置</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label>允许的 Origin</Label>
            <div className="flex gap-2 mt-1">
              <Input
                placeholder="输入 Origin (如 localhost)"
                value={newOrigin}
                onChange={(e) => setNewOrigin(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleAddOrigin()}
              />
              <Button onClick={handleAddOrigin}>添加</Button>
            </div>
            <div className="flex flex-wrap gap-2 mt-2">
              {settings.allowed_origins.map(origin => (
                <span
                  key={origin}
                  className="bg-secondary px-2 py-1 rounded flex items-center gap-1"
                >
                  {origin}
                  <button
                    onClick={() => handleRemoveOrigin(origin)}
                    className="text-muted-foreground hover:text-destructive ml-1"
                    type="button"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
            <p className="text-sm text-muted-foreground mt-2">
              允许通过浏览器访问代理服务器的 Origin 列表
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>关于</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p><strong>LODOP助手</strong> v1.0.0</p>
          <p>基于 Tauri + React + TypeScript 构建</p>
          <p>用于在 macOS 上访问 Windows C-Lodop 打印服务</p>
        </CardContent>
      </Card>

      <div className="flex gap-2">
        <Button onClick={handleSave}>保存设置</Button>
        <Button variant="outline" onClick={loadSettings}>重置</Button>
      </div>
    </div>
  )
}
