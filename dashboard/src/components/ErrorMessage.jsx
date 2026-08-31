function ErrorMessage({ message, onRetry }) {
  return (
    <div className="error-banner">
      <div className="error-content">
        <span className="error-icon">⚠️</span>
        <div className="error-text">
          <strong>Connection Error</strong>
          <p>{message}</p>
        </div>
      </div>
      {onRetry && (
        <button className="btn btn-secondary" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  )
}

export default ErrorMessage
