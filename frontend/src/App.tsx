import { useState, useEffect, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import HostDiscovery from './components/HostDiscovery'
import CurrentBinding from './components/CurrentBinding'
import Settings from './components/Settings'

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

interface ScanProgressEvent {
  scanned: number
  total: number
  found: number
}

interface HostFoundEvent {
  host: HostInfo
}

function App() {
  const [activeTab, setActiveTab] = useState('discovery')
  const [status, setStatus] = useState<StatusResponse | null>(null)
  const [scanProgress, setScanProgress] = useState<ScanProgressEvent | null>(null)

  // Load status from backend
  const loadStatus = useCallback(async () => {
    try {
      const result = await invoke<StatusResponse>('get_status')
      setStatus(result)
    } catch (error) {
      console.error('Failed to get status:', error)
    }
  }, [])

  useEffect(() => {
    loadStatus()
    const interval = setInterval(loadStatus, 5000)
    return () => clearInterval(interval)
  }, [loadStatus])

  // Listen for scan progress events
  useEffect(() => {
    const unlistenProgress = listen<ScanProgressEvent>('scan-progress', (event) => {
      setScanProgress(event.payload)
    })

    const unlistenHostFound = listen<HostFoundEvent>('host-found', (event) => {
      // Notify child components about new host
      console.log('Host found:', event.payload)
    })

    const unlistenScanComplete = listen<{ found: number }>('scan-complete', (event) => {
      console.log('Scan complete, found:', event.payload.found)
      setScanProgress(null)
      // Reload scan results
      loadStatus()
    })

    return () => {
      unlistenProgress.then(fn => fn())
      unlistenHostFound.then(fn => fn())
      unlistenScanComplete.then(fn => fn())
    }
  }, [loadStatus])

  return (
    <div className="flex flex-col h-screen bg-slate-50 font-sans">
      <header className="bg-white border-b px-6 py-4 shadow-sm">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded bg-blue-600 flex items-center justify-center">
              <span className="text-white font-bold text-sm">CL</span>
            </div>
            <h1 className="text-xl font-semibold">C-Lodop Client</h1>
          </div>
          {status?.boundHost && (
            <div className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">已绑定:</span>
              <span className="font-medium text-green-600">
                {status.boundHost.ip}:{status.boundHost.port}
              </span>
              <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></span>
            </div>
          )}
        </div>
        <Tabs value={activeTab} onValueChange={setActiveTab} className="mt-4">
          <TabsList>
            <TabsTrigger value="discovery">主机发现</TabsTrigger>
            <TabsTrigger value="binding">当前绑定</TabsTrigger>
            <TabsTrigger value="settings">设置</TabsTrigger>
          </TabsList>
        </Tabs>
      </header>
      <main className="flex-1 p-6 overflow-y-auto">
        {activeTab === 'discovery' && (
          <HostDiscovery
            scanProgress={scanProgress}
            onScanComplete={loadStatus}
          />
        )}
        {activeTab === 'binding' && (
          <CurrentBinding
            status={status}
            onRefresh={loadStatus}
          />
        )}
        {activeTab === 'settings' && <Settings />}
      </main>
    </div>
  )
}

export default App
