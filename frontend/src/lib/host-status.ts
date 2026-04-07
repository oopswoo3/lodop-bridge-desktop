export type HostStatusTone = 'online' | 'offline' | 'stale' | 'unknown'

const HOST_STATUS_LABEL: Record<HostStatusTone, string> = {
  online: '在线',
  offline: '离线',
  stale: '状态旧',
  unknown: '未知',
}

export function normalizeHostStatus(status?: string): HostStatusTone {
  if (status === 'online') {
    return 'online'
  }
  if (status === 'stale') {
    return 'stale'
  }
  if (status === 'offline') {
    return 'offline'
  }
  return 'unknown'
}

export function hostStatusLabel(status?: string): string {
  return HOST_STATUS_LABEL[normalizeHostStatus(status)]
}

