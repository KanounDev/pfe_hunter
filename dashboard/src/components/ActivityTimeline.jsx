function ActivityTimeline({ runs }) {
  if (runs.length === 0) {
    return <p className="text-muted text-center">No recent activity</p>
  }

  return (
    <div className="activity-list">
      {runs.map((run, index) => (
        <div key={index} className="activity-item">
          <div className={`activity-dot ${run.status === 'failed' ? 'activity-dot-error' : ''}`}></div>
          <div className="activity-content">
            <div className="activity-title">
              {run.status === 'success' ? (
                <>Scraped {run.inserted} posting(s), scored {run.scored}</>
              ) : (
                <>Pipeline failed: {run.step}</>
              )}
            </div>
            <div className="activity-meta">
              {formatTimestamp(run.timestamp)} • {run.elapsed_seconds}s
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

function formatTimestamp(isoString) {
  const date = new Date(isoString)
  const now = new Date()
  const diffMs = now - date
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMins / 60)
  const diffDays = Math.floor(diffHours / 24)

  if (diffMins < 1) return 'Just now'
  if (diffMins < 60) return `${diffMins}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  if (diffDays < 7) return `${diffDays}d ago`

  return date.toLocaleDateString()
}

export default ActivityTimeline
