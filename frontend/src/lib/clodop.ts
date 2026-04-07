import { invoke } from '@tauri-apps/api/core'

type LodopRecord = Record<string, unknown>

declare global {
  interface Window {
    LODOP?: LodopRecord
    getCLodop?: () => LodopRecord | null
    On_CLodop_Opened?: () => void
  }
}

export interface ProxyInfo {
  port: number
  baseUrl: string
  demoUrl: string
}

let scriptPromise: Promise<void> | null = null
let loadedScriptUrl: string | null = null

export async function getProxyInfo(): Promise<ProxyInfo> {
  return invoke<ProxyInfo>('get_proxy_info')
}

export async function ensureCLodopReady(baseUrl: string): Promise<void> {
  await loadScript(baseUrl)
  await waitForCLodopOpen(10_000)
  getLodopObject()
}

export async function fetchPrinters(baseUrl: string): Promise<string[]> {
  await ensureCLodopReady(baseUrl)

  const countValue = await callLodopMethod('GET_PRINTER_COUNT', [])
  const count = Number(countValue)
  const printers: string[] = []

  if (Number.isFinite(count) && count > 0) {
    for (let idx = 1; idx <= count; idx += 1) {
      const nameValue = await callLodopMethod('GET_PRINTER_NAME', [idx])
      const name = String(nameValue ?? '').trim()
      if (name) {
        printers.push(name)
      }
    }
  }

  if (printers.length === 0) {
    try {
      const listValue = await callLodopMethod('Create_Printer_List', [])
      printers.push(...normalizePrinterList(listValue))
    } catch {
      // Some CLodop builds do not expose Create_Printer_List.
    }
  }

  return Array.from(new Set(printers))
}

export async function runTestPrint(baseUrl: string, printer: string | null): Promise<void> {
  await ensureCLodopReady(baseUrl)

  await callLodopMethod('PRINT_INIT', ['测试打印'])

  if (printer) {
    const printers = await fetchPrinters(baseUrl)
    const printerIndex = printers.findIndex((item) => item === printer)
    if (printerIndex >= 0) {
      await callLodopMethod('SET_PRINTER_INDEX', [printerIndex + 1])
    }
  }

  await callLodopMethod('SET_PRINT_PAGESIZE', [1, 'A4', '', ''])
  await callLodopMethod('ADD_PRINT_TEXT', [10, 10, 300, 30, '这是测试打印内容'])
  await callLodopMethod('ADD_PRINT_TEXT', [10, 50, 300, 30, '测试中文多行文本'])
  await callLodopMethod('PRINT', [])
}

async function loadScript(baseUrl: string): Promise<void> {
  const normalizedBase = baseUrl.replace(/\/$/, '')
  const scriptUrl = `${normalizedBase}/CLodopfuncs.js`

  if (loadedScriptUrl === scriptUrl && scriptPromise) {
    return scriptPromise
  }

  const oldScript = document.getElementById('clodop-script')
  if (oldScript) {
    oldScript.remove()
  }

  loadedScriptUrl = null
  scriptPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    script.id = 'clodop-script'
    script.src = `${scriptUrl}?t=${Date.now()}`
    script.async = true
    script.onload = () => {
      loadedScriptUrl = scriptUrl
      resolve()
    }
    script.onerror = () => {
      script.remove()
      scriptPromise = null
      loadedScriptUrl = null
      reject(new Error(`加载 CLodopfuncs.js 失败: ${scriptUrl}`))
    }
    document.head.appendChild(script)
  })

  return scriptPromise
}

function getLodopObject(): LodopRecord {
  if (typeof window.getCLodop === 'function') {
    const lodop = window.getCLodop()
    if (lodop) {
      return lodop
    }
  }

  if (window.LODOP && typeof window.LODOP === 'object') {
    return window.LODOP
  }

  throw new Error('无法获取 LODOP 对象')
}

function normalizeReturnValue(value: unknown): unknown {
  if (value && typeof value === 'object' && 'Value' in (value as Record<string, unknown>)) {
    return (value as Record<string, unknown>).Value
  }
  return value
}

async function callLodopMethod(method: string, args: unknown[]): Promise<unknown> {
  const lodop = getLodopObject()
  const rawMethod = lodop[method]

  if (typeof rawMethod !== 'function') {
    throw new Error(`LODOP 方法不存在: ${method}`)
  }

  const result = await Promise.resolve(
    (rawMethod as (...input: unknown[]) => unknown).apply(lodop, args),
  )

  return normalizeReturnValue(result)
}

async function waitForCLodopOpen(timeoutMs: number): Promise<void> {
  try {
    getLodopObject()
    return
  } catch {
    // ignore and wait for callback
  }

  await new Promise<void>((resolve, reject) => {
    const startedAt = Date.now()
    const previousHandler = window.On_CLodop_Opened
    let settled = false

    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      window.On_CLodop_Opened = previousHandler
      clearInterval(pollTimer)
      clearTimeout(timeoutTimer)
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    }

    window.On_CLodop_Opened = () => {
      if (previousHandler) {
        previousHandler()
      }
      finish()
    }

    const pollTimer = window.setInterval(() => {
      try {
        getLodopObject()
        finish()
      } catch {
        if (Date.now() - startedAt > timeoutMs) {
          finish(new Error('等待 C-Lodop 连接超时'))
        }
      }
    }, 200)

    const timeoutTimer = window.setTimeout(() => {
      finish(new Error('等待 C-Lodop 连接超时'))
    }, timeoutMs)
  })
}

function normalizePrinterList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean)
  }

  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) {
      return []
    }

    try {
      const parsed = JSON.parse(trimmed)
      if (Array.isArray(parsed)) {
        return parsed.map((item) => String(item).trim()).filter(Boolean)
      }
    } catch {
      // fall through
    }

    return trimmed
      .split(/\r?\n|,/)
      .map((item) => item.trim())
      .filter(Boolean)
  }

  return []
}
