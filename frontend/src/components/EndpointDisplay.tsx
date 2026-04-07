import { useState } from 'react'
import { Check, Copy, Server, Signal } from 'lucide-react'
import { cn } from '@/lib/utils'
import { normalizeHostStatus } from '@/lib/host-status'

export interface EndpointViewModel {
  ip: string
  port: number
  status?: string
  rtt?: number | null
  copyValue?: string
}

export interface EndpointDisplayProps {
  endpoint: EndpointViewModel
  compact?: boolean
  showCopy?: boolean
  emphasize?: 'primary' | 'secondary'
  className?: string
}

async function copyToClipboard(value: string): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value)
    return
  }

  if (typeof document === 'undefined') {
    throw new Error('clipboard unavailable')
  }

  const textarea = document.createElement('textarea')
  textarea.value = value
  textarea.setAttribute('readonly', 'true')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  document.execCommand('copy')
  document.body.removeChild(textarea)
}

export default function EndpointDisplay({
  endpoint,
  compact = false,
  showCopy = false,
  emphasize = 'secondary',
  className,
}: EndpointDisplayProps) {
  const [copied, setCopied] = useState(false)
  const statusTone = normalizeHostStatus(endpoint.status)
  const copyValue = endpoint.copyValue ?? `${endpoint.ip}:${endpoint.port}`
  const hasRtt = Number.isFinite(endpoint.rtt) && endpoint.rtt !== null

  const handleCopy = async () => {
    try {
      await copyToClipboard(copyValue)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1400)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div
      className={cn(
        'bridge-endpoint-shell',
        compact ? 'bridge-endpoint-shell-compact' : undefined,
        emphasize === 'primary' ? 'bridge-endpoint-shell-primary' : undefined,
        className,
      )}
    >
      <div className="bridge-endpoint-main">
        <span
          className={cn(
            'bridge-endpoint-dot',
            `bridge-endpoint-dot-${statusTone}`,
            statusTone === 'online' ? 'bridge-online-pulse' : undefined,
          )}
          aria-hidden="true"
        />
        <Server className="h-3.5 w-3.5 shrink-0 text-slate-500" aria-hidden="true" />
        <span className="bridge-endpoint-ip">{`${endpoint.ip}:${endpoint.port}`}</span>
        {showCopy ? (
          <button
            type="button"
            className="bridge-endpoint-copy-inline"
            onClick={() => void handleCopy()}
            aria-label={copied ? '已复制' : '复制地址'}
            title={copied ? '已复制' : '复制地址'}
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          </button>
        ) : null}
      </div>

      <div className="bridge-endpoint-meta">
        {hasRtt && (
          <span className="bridge-endpoint-rtt">
            <Signal className="h-3 w-3" aria-hidden="true" />
            {Math.round(endpoint.rtt ?? 0)}ms
          </span>
        )}
      </div>
    </div>
  )
}
