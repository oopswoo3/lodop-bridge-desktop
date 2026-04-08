const DEFAULT_HIDDEN_PORTS = new Set([8000, 18000])

export function isHiddenDefaultPort(port: number): boolean {
  return DEFAULT_HIDDEN_PORTS.has(port)
}

export function formatEndpointLabel(ip: string, port: number): string {
  return isHiddenDefaultPort(port) ? ip : `${ip}:${port}`
}
