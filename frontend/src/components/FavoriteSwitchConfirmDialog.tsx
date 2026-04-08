import { Button } from '@/components/ui/button'

interface FavoriteSwitchConfirmDialogProps {
  open: boolean
  mode: 'connect' | 'remove'
  endpoint: string
  currentEndpoint?: string | null
  onCancel: () => void
  onConfirm: () => void
  confirmLoading?: boolean
}

export default function FavoriteSwitchConfirmDialog({
  open,
  mode,
  endpoint,
  currentEndpoint,
  onCancel,
  onConfirm,
  confirmLoading = false,
}: FavoriteSwitchConfirmDialogProps) {
  if (!open) {
    return null
  }

  const isRemoveMode = mode === 'remove'
  const title = isRemoveMode ? '移除收藏' : '连接主机'
  const primaryLine = isRemoveMode ? `确认移除 ${endpoint}？` : `连接 ${endpoint}`
  const secondaryLine = isRemoveMode
    ? '此操作不可撤销。'
    : currentEndpoint && currentEndpoint !== endpoint
      ? `将断开 ${currentEndpoint} 后连接。`
      : null
  const confirmText = isRemoveMode ? (confirmLoading ? '移除中...' : '确认移除') : confirmLoading ? '连接中...' : '确认连接'

  return (
    <div
      className="fixed inset-0 z-[130] flex items-center justify-center overflow-hidden bg-slate-900/35 p-4 cursor-pointer"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md max-h-full overflow-y-auto rounded-2xl border border-[color:var(--bridge-border)] bg-white p-5 shadow-[0_24px_52px_-30px_rgba(15,23,42,0.6)] cursor-default"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-4">
          <h3 className="text-lg font-bold tracking-tight text-slate-900">{title}</h3>
          <p className="mt-2 text-[15px] font-semibold font-mono text-slate-900">{primaryLine}</p>
          {secondaryLine && <p className="mt-1 text-sm text-slate-500">{secondaryLine}</p>}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <Button
            variant="outline"
            onClick={onCancel}
            disabled={confirmLoading}
            className="h-9 rounded-lg border-[color:var(--bridge-border)] bg-white px-4 text-slate-700 hover:!bg-slate-50 hover:!text-slate-700"
          >
            取消
          </Button>
          <Button
            onClick={onConfirm}
            disabled={confirmLoading}
            className={
              isRemoveMode
                ? 'h-9 rounded-lg bg-rose-600 px-4 text-white hover:!bg-rose-700 hover:!text-white'
                : 'h-9 rounded-lg bg-[color:var(--bridge-primary)] px-4 text-white hover:!bg-[color:var(--bridge-primary-strong)] hover:!text-white'
            }
          >
            {confirmText}
          </Button>
        </div>
      </div>
    </div>
  )
}
