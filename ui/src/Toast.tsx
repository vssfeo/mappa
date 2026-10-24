import { useEffect } from 'react'
import { CheckCircle2, X } from 'lucide-react'
import { useT } from './i18n'
import { useAppStore } from './store'

export function Toast() {
  const t = useT()
  const toast = useAppStore((state) => state.toast)
  const clearToast = useAppStore((state) => state.clearToast)

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(clearToast, 4200)
    return () => window.clearTimeout(timer)
  }, [toast, clearToast])

  if (!toast) return null

  return (
    <div className="toast" role="status" aria-live="polite" aria-atomic="true" key={toast.id}>
      <span className="toast-icon">
        <CheckCircle2 size={16} />
      </span>
      <span>{toast.message}</span>
      <button
        type="button"
        className="toast-close"
        onClick={clearToast}
        aria-label={t('toast.close')}
      >
        <X size={14} />
      </button>
    </div>
  )
}
