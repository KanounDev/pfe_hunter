import { createContext, useContext, useState, useCallback, useRef } from 'react'
import './Toast.css'

/**
 * Lightweight toast notifications (no external dependency).
 *
 * Replaces scattered inline success/error messages: after clicking "Save" at
 * the bottom of a long page, feedback now appears in a fixed overlay no
 * matter where the user is looking.
 *
 * Usage:
 *   const toast = useToast()
 *   toast.success('Settings saved')
 *   toast.error('Failed to save: ' + err.message)
 */

const ToastContext = createContext(null)

export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>')
  return ctx
}

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])
  const idRef = useRef(0)

  const dismiss = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const push = useCallback((type, message) => {
    const id = ++idRef.current
    setToasts((prev) => [...prev.slice(-2), { id, type, message }]) // keep at most 3
    setTimeout(() => dismiss(id), 4000)
  }, [dismiss])

  const toast = {
    success: useCallback((msg) => push('success', msg), [push]),
    error: useCallback((msg) => push('error', msg), [push]),
    info: useCallback((msg) => push('info', msg), [push]),
  }

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div className="toast-container" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.type}`}>
            <span className="toast-icon">
              {t.type === 'success' ? '✅' : t.type === 'error' ? '⚠️' : 'ℹ️'}
            </span>
            <span className="toast-message">{t.message}</span>
            <button className="toast-close" onClick={() => dismiss(t.id)} aria-label="Dismiss">
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}
