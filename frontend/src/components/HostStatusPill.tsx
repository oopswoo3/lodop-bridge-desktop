import { cn } from '@/lib/utils'
import { hostStatusLabel, normalizeHostStatus } from '@/lib/host-status'

interface HostStatusPillProps {
  status?: string
  className?: string
  showPulse?: boolean
}

export default function HostStatusPill({ status, className, showPulse = false }: HostStatusPillProps) {
  const tone = normalizeHostStatus(status)

  return (
    <span className={cn('bridge-status-pill', `bridge-status-pill-${tone}`, className)}>
      <span
        className={cn(
          'bridge-status-pill-dot',
          `bridge-status-pill-dot-${tone}`,
          tone === 'online' && showPulse ? 'bridge-online-pulse' : undefined,
        )}
      />
      {hostStatusLabel(status)}
    </span>
  )
}
