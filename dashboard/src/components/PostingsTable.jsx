function PostingsTable({ postings, onRowClick }) {
  return (
    <div className="table-container">
      <table className="table">
        <thead>
          <tr>
            <th>Title</th>
            <th>Company</th>
            <th>Location</th>
            <th>Fit Score</th>
            <th>Reasoning</th>
            <th>Created</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {postings.map((posting) => (
            <tr key={posting.job_id} onClick={() => onRowClick(posting)}>
              <td>
                <a
                  href={posting.job_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="job-link"
                  onClick={(e) => e.stopPropagation()}
                >
                  {posting.title}
                </a>
              </td>
              <td>{posting.company || '—'}</td>
              <td>{posting.location || '—'}</td>
              <td>
                <ScoreBadge score={posting.fit_score} />
              </td>
              <td className="reasoning-cell">
                {truncate(posting.fit_reasoning, 50)}
              </td>
              <td>{formatDate(posting.created_at)}</td>
              <td>
                {posting.notified_at ? (
                  <span className="badge badge-success">Notified</span>
                ) : (
                  <span className="badge badge-neutral">Pending</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ScoreBadge({ score }) {
  if (score === null || score === undefined) {
    return <span className="badge badge-neutral">—</span>
  }

  let className = 'badge '
  if (score >= 70) className += 'badge-success'
  else if (score >= 50) className += 'badge-warning'
  else className += 'badge-error'

  return <span className={className}>{score}</span>
}

function truncate(text, maxLength) {
  if (!text) return '—'
  if (text.length <= maxLength) return text
  return text.slice(0, maxLength) + '...'
}

function formatDate(isoString) {
  if (!isoString) return '—'
  const date = new Date(isoString)
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

export default PostingsTable
