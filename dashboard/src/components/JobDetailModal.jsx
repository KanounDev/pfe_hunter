function JobDetailModal({ job, onClose }) {
  if (!job) return null

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <h2 className="modal-title">{job.title}</h2>
            <p className="modal-subtitle">{job.company} • {job.location || 'Location not specified'}</p>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="modal-body">
          {/* Score Section */}
          <div className="detail-section">
            <h3 className="detail-heading">Fit Score</h3>
            <div className="score-display">
              <ScoreCircle score={job.fit_score} />
              <div className="score-reasoning">
                <h4>Why this score?</h4>
                <p>{job.fit_reasoning || 'No reasoning provided'}</p>
              </div>
            </div>
          </div>

          {/* Job Description */}
          <div className="detail-section">
            <h3 className="detail-heading">Job Description</h3>
            <p className="description-text">{job.description || 'No description available'}</p>
          </div>

          {/* Metadata */}
          <div className="detail-section">
            <h3 className="detail-heading">Details</h3>
            <div className="metadata-grid">
              <div className="metadata-item">
                <span className="metadata-label">Source</span>
                <a
                  href={job.job_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="metadata-link"
                >
                  View on LinkedIn →
                </a>
              </div>
              <div className="metadata-item">
                <span className="metadata-label">Created</span>
                <span className="metadata-value">{formatDateTime(job.created_at)}</span>
              </div>
              <div className="metadata-item">
                <span className="metadata-label">Scored</span>
                <span className="metadata-value">{formatDateTime(job.scored_at)}</span>
              </div>
              <div className="metadata-item">
                <span className="metadata-label">Notification</span>
                <span className="metadata-value">
                  {job.notified_at ? formatDateTime(job.notified_at) : 'Not sent'}
                </span>
              </div>
            </div>
          </div>

          {/* Actions */}
          <div className="modal-actions">
            <a
              href={job.job_url}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-primary"
            >
              Apply on LinkedIn →
            </a>
            <button className="btn btn-secondary" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function ScoreCircle({ score }) {
  if (score === null || score === undefined) {
    return (
      <div className="score-circle score-circle-none">
        <span>—</span>
      </div>
    )
  }

  let colorClass = 'score-circle-low'
  if (score >= 70) colorClass = 'score-circle-high'
  else if (score >= 50) colorClass = 'score-circle-medium'

  return (
    <div className={`score-circle ${colorClass}`}>
      <span className="score-number">{score}</span>
      <span className="score-label">/100</span>
    </div>
  )
}

function formatDateTime(isoString) {
  if (!isoString) return '—'
  const date = new Date(isoString)
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export default JobDetailModal
