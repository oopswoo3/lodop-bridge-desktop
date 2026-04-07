export type NoticeType = 'success' | 'error'

export interface NoticeItem {
  id: number
  type: NoticeType
  text: string
  durationMs: number
}

export interface ShowNoticeOptions {
  durationMs?: number
}

export type ShowNoticeFn = (type: NoticeType, text: string, options?: ShowNoticeOptions) => void

interface FloatingNoticeHostProps {
  notices: NoticeItem[]
  onClose: (id: number) => void
}

function noticeBoxClass(type: NoticeType): string {
  if (type === 'success') {
    return 'border-emerald-200 bg-emerald-50 text-emerald-800'
  }
  return 'border-rose-200 bg-rose-50 text-rose-800'
}

export default function FloatingNoticeHost({ notices, onClose }: FloatingNoticeHostProps) {
  if (notices.length === 0) {
    return null
  }

  return (
    <div className="pointer-events-none fixed right-4 top-4 z-[120] flex w-[min(92vw,380px)] flex-col gap-2">
      {notices.map((notice) => (
        <div
          key={notice.id}
          className={`pointer-events-auto rounded-xl border px-3 py-2.5 text-sm shadow-[0_16px_28px_-20px_rgba(15,23,42,0.45)] ${noticeBoxClass(
            notice.type
          )}`}
        >
          <div className="flex items-start justify-between gap-2">
            <span className="leading-5">{notice.text}</span>
            <button
              type="button"
              onClick={() => onClose(notice.id)}
              className="h-5 w-5 shrink-0 rounded-md text-current/70 cursor-pointer hover:bg-white/60 hover:text-current"
              aria-label="关闭提示"
            >
              ×
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
