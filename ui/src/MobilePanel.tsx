import { useRef, useState } from 'react'
import { Copy, Loader2, Phone, Square, X } from 'lucide-react'
import { useText } from './i18n'
import { useAppStore } from './store'
import { startMobileServer, stopMobileServer, type MobileInfo } from './mobile'
import { useDialogFocus } from './useDialogFocus'

interface MobilePanelProps {
  onClose: () => void
}

/** Starts the local tile server and shows its QR code. */
export function MobilePanel({ onClose }: MobilePanelProps) {
  const tx = useText()
  const packs = useAppStore((state) => state.packs)
  const showToast = useAppStore((state) => state.showToast)
  const dialogRef = useRef<HTMLElement | null>(null)
  useDialogFocus(dialogRef, onClose)
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(packs.map((pack) => pack.path)),
  )
  const [tls, setTls] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<MobileInfo | null>(null)

  const start = async () => {
    setBusy(true)
    setError(null)
    try {
      setInfo(
        await startMobileServer(
          packs.filter((pack) => selected.has(pack.path)).map((pack) => pack.path),
          tls,
        ),
      )
    } catch (cause) {
      setError(String(cause))
    } finally {
      setBusy(false)
    }
  }

  const stop = async () => {
    setBusy(true)
    try {
      await stopMobileServer()
      setInfo(null)
    } catch (cause) {
      setError(String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className="los-modal"
        role="dialog"
        aria-modal="true"
        aria-label={tx('Телефон', 'Phone')}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <div>
            <span className="eyebrow">{tx('Поле', 'Field')}</span>
            <h2>{tx('Телефон', 'Phone')}</h2>
          </div>
          <button
            type="button"
            className="onboarding-close"
            onClick={onClose}
            aria-label={tx('Закрыть', 'Close')}
          >
            <X size={15} />
          </button>
        </header>

        <p className="settings-hint">
          {tx(
            'Запускает mappa serve на этом компьютере и показывает QR. Телефон должен быть в той же сети. Самоподписанный сертификат нужно принять один раз.',
            'Starts mappa serve on this computer and shows a QR. The phone must be on the same network. Accept the self-signed certificate once.',
          )}
        </p>

        {packs.length > 0 && (
          <>
            <p className="settings-hint">{tx('Паки', 'Packs')}</p>
            {packs.map((pack) => (
              <label key={pack.path} className="source-check">
                <input
                  type="checkbox"
                  checked={selected.has(pack.path)}
                  onChange={() =>
                    setSelected((current) => {
                      const next = new Set(current)
                      if (next.has(pack.path)) next.delete(pack.path)
                      else next.add(pack.path)
                      return next
                    })
                  }
                />
                {pack.name}
              </label>
            ))}
          </>
        )}

        <label className="source-check">
          <input
            type="checkbox"
            checked={tls}
            onChange={(event) => setTls(event.target.checked)}
          />
          {tx('HTTPS с самоподписанным сертификатом (нужен для GPS)', 'HTTPS with a self-signed certificate (needed for GPS)')}
        </label>

        <div className="marker-actions">
          <button
            type="button"
            className="primary-button"
            disabled={busy}
            onClick={() => void start()}
          >
            {busy ? <Loader2 size={14} className="spin" /> : <Phone size={14} />}
            {tx('Запустить', 'Start')}
          </button>
          <button
            type="button"
            className="ghost-button"
            disabled={busy || !info}
            onClick={() => void stop()}
          >
            <Square size={14} />
            {tx('Остановить', 'Stop')}
          </button>
        </div>

        {error && <p className="georef-error">{error}</p>}
        {info && (
          <div className="mobile-qr-panel">
            <div
              className="mobile-qr"
              dangerouslySetInnerHTML={{ __html: info.qrSvg }}
            />
            <div className="marker-actions">
              <code className="mobile-url">{info.url}</code>
              <button
                type="button"
                className="ghost-button"
                onClick={() => {
                  void navigator.clipboard.writeText(info.url)
                  showToast(tx('Ссылка скопирована', 'Link copied'))
                }}
              >
                <Copy size={14} />
                {tx('Копировать', 'Copy')}
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  )
}
