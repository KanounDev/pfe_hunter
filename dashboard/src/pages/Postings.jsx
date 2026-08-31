import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getPostings } from '../api/index.js'
import PostingsTable from '../components/PostingsTable'
import PostingsFilters from '../components/PostingsFilters'
import JobDetailModal from '../components/JobDetailModal'
import ErrorMessage from '../components/ErrorMessage'
import '../styles/Postings.css'

// Auto-refresh interval (30 seconds)
const REFETCH_INTERVAL = 30 * 1000

function Postings() {
  const [filters, setFilters] = useState({
    minScore: 0,
    maxScore: 100,
    company: '',
    location: '',
    notified: 'all',
  })

  const [selectedJob, setSelectedJob] = useState(null)

  const { data: postings, isLoading, error, refetch } = useQuery({
    queryKey: ['postings', filters],
    queryFn: () => getPostings({
      minScore: filters.minScore,
      maxScore: filters.maxScore,
      company: filters.company || undefined,
      location: filters.location || undefined,
      notified: filters.notified,
    }),
    refetchInterval: REFETCH_INTERVAL,
    retry: 2,
  })

  return (
    <div className="page">
      <div className="page-header">
        <div className="page-header-row">
          <div>
            <h1 className="page-title">Job Postings</h1>
            <p className="page-description">
              {postings ? `${postings.length} posting(s) found` : 'Loading...'} • Auto-refreshes every 30s
            </p>
          </div>
          <button className="btn btn-secondary" onClick={() => refetch()}>
            ↻ Refresh Now
          </button>
        </div>
      </div>

      {/* Error Banner */}
      {error && (
        <ErrorMessage
          message={error.message}
          onRetry={() => refetch()}
        />
      )}

      <PostingsFilters filters={filters} onChange={setFilters} />

      {isLoading && !postings ? (
        <div className="loading-state">
          <div className="spinner"></div>
          <p>Loading postings...</p>
        </div>
      ) : postings && postings.length > 0 ? (
        <PostingsTable
          postings={postings}
          onRowClick={setSelectedJob}
        />
      ) : (
        <div className="empty-state">
          <span className="empty-icon">🔍</span>
          <h3>No postings found</h3>
          <p>
            {filters.company || filters.location || filters.minScore > 0 || filters.maxScore < 100
              ? 'Try adjusting your filters'
              : 'Run the scraper to fetch job postings from LinkedIn'}
          </p>
        </div>
      )}

      {selectedJob && (
        <JobDetailModal
          job={selectedJob}
          onClose={() => setSelectedJob(null)}
        />
      )}
    </div>
  )
}

export default Postings
