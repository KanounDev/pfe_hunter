import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getStats, getRuns, getScoreDistribution, triggerPipeline } from '../api/api'
import StatCard from '../components/StatCard'
import ActivityTimeline from '../components/ActivityTimeline'
import ScoreChart from '../components/ScoreChart'
import ErrorMessage from '../components/ErrorMessage'
import RunNowButton from '../components/RunNowButton'
import FitScoreInfo from '../components/FitScoreInfo'
import { useToast } from '../components/Toast'
import '../styles/Dashboard.css'

// Auto-refresh interval (30 seconds)
const REFETCH_INTERVAL = 30 * 1000

function Dashboard() {
  const toast = useToast()
  const [firstRunLoading, setFirstRunLoading] = useState(false)

  const { data: stats, isLoading: statsLoading, error: statsError, refetch: refetchStats } = useQuery({
    queryKey: ['stats'],
    queryFn: getStats,
    refetchInterval: REFETCH_INTERVAL,
    retry: 2,
  })

  const { data: runs, isLoading: runsLoading, error: runsError, refetch: refetchRuns } = useQuery({
    queryKey: ['runs'],
    queryFn: () => getRuns(10),
    refetchInterval: REFETCH_INTERVAL,
    retry: 2,
  })

  const { data: distribution, isLoading: distributionLoading, error: distributionError } = useQuery({
    queryKey: ['distribution'],
    queryFn: getScoreDistribution,
    refetchInterval: REFETCH_INTERVAL,
    retry: 2,
  })

  // One-click first run from the empty activity state
  const handleFirstRun = async () => {
    try {
      setFirstRunLoading(true)
      await triggerPipeline()
      toast.success('Pipeline started — progress appears on the Dashboard header.')
      refetchRuns()
    } catch (err) {
      toast.error('Failed to start pipeline: ' + err.message)
    } finally {
      setFirstRunLoading(false)
    }
  }

  // Show error if any query failed
  const hasError = statsError || runsError || distributionError
  const errorMessage = statsError?.message || runsError?.message || distributionError?.message

  return (
    <div className="page">
      <div className="page-header">
        <div className="page-header-row">
          <div>
            <h1 className="page-title">Dashboard</h1>
            <p className="page-description">Overview of your job search progress • Auto-refreshes every 30s</p>
          </div>
          <div className="header-actions">
            <RunNowButton />
            <button className="btn btn-secondary" onClick={() => { refetchStats(); refetchRuns(); }}>
              ↻ Refresh Now
            </button>
          </div>
        </div>
      </div>

      {/* Error Banner */}
      {hasError && (
        <ErrorMessage
          message={errorMessage}
          onRetry={() => { refetchStats(); refetchRuns(); }}
        />
      )}

      {/* Stats Cards */}
      <div className="stats-grid">
        {statsLoading && !stats ? (
          <>
            <StatCardSkeleton />
            <StatCardSkeleton />
            <StatCardSkeleton />
            <StatCardSkeleton />
          </>
        ) : stats ? (
          <>
            <StatCard
              title="Total Postings"
              value={stats.total || 0}
              icon="📋"
            />
            <StatCard
              title="Average Fit Score"
              value={stats.averageScore || 0}
              icon="📊"
              extra={<FitScoreInfo />}
            />
            <StatCard
              title="High-Fit Matches"
              value={stats.highFit || 0}
              icon="🎯"
              subtitle="Score ≥ 70"
            />
            <StatCard
              title="Notified"
              value={stats.notified || 0}
              icon="🔔"
              subtitle="Discord alerts sent"
            />
          </>
        ) : null}
      </div>

      {/* Charts and Activity */}
      <div className="dashboard-grid">
        {/* Score Distribution Chart */}
        <div className="card">
          <div className="card-header">
            <h3 className="card-title">Fit Score Distribution</h3>
          </div>
          {distributionLoading && !distribution ? (
            <div className="chart-loading">Loading chart...</div>
          ) : distribution ? (
            Object.values(distribution).every(v => v === 0) ? (
              <div className="empty-chart">
                <span className="empty-chart-icon">📊</span>
                <p>No scored postings yet</p>
                <p className="text-muted">Run the scraper to see distribution</p>
              </div>
            ) : (
              <div className="chart-container">
                <ScoreChart data={distribution} />
              </div>
            )
          ) : null}
        </div>

        {/* Recent Activity */}
        <div className="card">
          <div className="card-header">
            <h3 className="card-title">Recent Activity</h3>
          </div>
          {runsLoading && !runs ? (
            <div className="activity-loading">Loading activity...</div>
          ) : runs ? (
            runs.length === 0 ? (
              <div className="empty-activity">
                <span className="empty-chart-icon">⏱️</span>
                <p>No activity yet</p>
                <p className="text-muted">
                  Run your first pipeline to start collecting and scoring job postings.
                  It also runs automatically every 5 hours via GitHub Actions.
                </p>
                <button
                  className="btn btn-primary empty-activity-cta"
                  onClick={handleFirstRun}
                  disabled={firstRunLoading}
                >
                  {firstRunLoading ? 'Starting...' : '▶️ Run your first pipeline'}
                </button>
              </div>
            ) : (
              <ActivityTimeline runs={runs} />
            )
          ) : null}
        </div>
      </div>
    </div>
  )
}

function StatCardSkeleton() {
  return (
    <div className="stat-card stat-card-loading">
      <div className="stat-card-header">
        <div className="stat-card-icon skeleton"></div>
        <span className="stat-card-title skeleton-text">Loading...</span>
      </div>
      <div className="stat-card-value skeleton-text">--</div>
    </div>
  )
}

export default Dashboard
