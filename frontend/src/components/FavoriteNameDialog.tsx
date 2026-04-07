import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

interface FavoriteNameDialogProps {
  open: boolean
  initialName: string
  loading: boolean
  onConfirm: (name: string) => Promise<void> | void
  onCancel: () => void
}

export default function FavoriteNameDialog({
  open,
  initialName,
  loading,
  onConfirm,
  onCancel,
}: FavoriteNameDialogProps) {
  const [name, setName] = useState(initialName)

  useEffect(() => {
    if (open) {
      setName(initialName)
    }
  }, [open, initialName])

  if (!open) {
    return null
  }

  return (
    <div className="fixed inset-0 z-[130] bg-slate-900/35 p-4 cursor-pointer" onClick={onCancel}>
      <div
        className="mx-auto mt-[12vh] w-full max-w-md rounded-2xl border border-[color:var(--bridge-border)] bg-white p-4 shadow-[0_24px_52px_-30px_rgba(15,23,42,0.6)] cursor-default"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-3">
          <h3 className="text-base font-bold text-slate-900">编辑收藏备注</h3>
          <p className="mt-1 text-xs text-slate-500">可留空。</p>
        </div>

        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="输入备注名（可留空）"
          className="h-9 rounded-lg border-[color:var(--bridge-border)] bg-white text-sm"
          autoFocus
        />

        <div className="mt-4 flex justify-end gap-2">
          <Button
            variant="outline"
            onClick={onCancel}
            disabled={loading}
            className="h-8 rounded-lg border-[color:var(--bridge-border)] bg-white text-slate-700 hover:bg-slate-50"
          >
            取消
          </Button>
          <Button
            onClick={() => void onConfirm(name)}
            disabled={loading}
            className="h-8 rounded-lg bg-[color:var(--bridge-primary)] text-white hover:brightness-110"
          >
            {loading ? '保存中...' : '保存'}
          </Button>
        </div>
      </div>
    </div>
  )
}
