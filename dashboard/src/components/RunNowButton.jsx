import { useState, useEffect, useCallback } from 'react'
import { triggerPipeline, getPipelineStatus, getPipelineRuns } from '../api/api'
import '../styles/RunNowButton.css'

function RunNowButton() {
  const [runStatus, setRunStatus] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  // Poll for status updates when a run is in progress
  useEffect(() => {
    let interval

    const fetchStatus = async () => {
      try {
        const data = await getPipelineStatus()
        setRunStatus(data.run)

        // Stop polling if run is complete
        if (data.run && data.run.status !== 'running') {
          clearInterval(interval)
        }
      } catch (err) {
        console.error('Failed to fetch pipeline status:', err)
      }
    }

    // Fetch initial status
    fetchStatus()

    // If a run is active, poll every 2 seconds
    if (runStatus?.status === 'running') {
      interval = setInterval(fetchStatus, 2000)
    }

    return () => {
      if (interval) clearInterval(interval)
    }
  }, [runStatus?.status])

  const handleRunNow = async () => {
    try {
      setLoading(true)
      setError(null)

      const data = await triggerPipeline()
      setRunStatus(data.run)

      // Start polling for updates
      const pollInterval = setInterval(async () => {
        try {
          const statusData = await getPipelineStatus()
          setRunStatus(statusData.run)

          if (statusData.run && statusData.run.status !== 'running') {
            clearInterval(pollInterval)
          }
        } catch (err) {
          console.error('Polling error:', err)
        }
      }, 2000)

      // Clean up interval after 10 minutes max
      setTimeout(() => clearInterval(pollInterval), 600000)

    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const getStepLabel = (step) => {
    const labels = {
      'initializing': 'Initializing...',
      'scraper': 'Scraping job postings',
      'scoring': 'Scoring with Gemini AI',
      'completed': 'Completed',
      'error': 'Error'
    }
    return labels[step] || step
  }

  const getProgressPercentage = () => {
    if (!runStatus) return 0

    const steps = ['initializing', 'scraper', 'scoring', 'completed']
    const currentIndex = steps.indexOf(runStatus.step)

    if (currentIndex === -1) return 0
    if (runStatus.status === 'failed') return 0

    return ((currentIndex + 1) / steps.length) * 100
  }

  const isRunning = runStatus?.status === 'running'

  return (
    <div className="run-now-container">
      <button
        className={`run-now-btn ${isRunning ? 'running' : ''}`}
        onClick={handleRunNow}
        disabled={loading || isRunning}
      >
        {loading ? 'Starting...' : isRunning ? 'Running...' : '▶️ Run Now'}
      </button>

      {error && (
        <div className="run-error">
          <span className="error-icon">⚠️</span>
          {error}
        </div>
      )}

      {isRunning && (
        <div className="run-progress">
          <div className="progress-header">
            <span className="progress-step">{getStepLabel(runStatus.step)}</span>
            <span className="progress-time">
              {runStatus.elapsed_seconds
                ? `${Math.round(runStatus.elapsed_seconds)}s elapsed`
                : 'Just started'}
            </span>
          </div>

          <div className="progress-bar">
            <div
              className="progress-fill"
              style={{ width: `${getProgressPercentage()}%` }}
            />
          </div>

          <div className="progress-stats">
            <span>📊 {runStatus.postings_found || 0} found</span>
            <span>💾 {runStatus.postings_inserted || 0} inserted</span>
            <span>🎯 {runStatus.postings_scored || 0} scored</span>
          </div>
        </div>
      )}

      {runStatus && runStatus.status === 'success' && (
        <div className="run-success">
          <span className="success-icon">✅</span>
          <span>Run completed successfully!</span>
          <span className="success-stats">
            {runStatus.postings_inserted} jobs inserted, {runStatus.postings_scored} scored in {runStatus.elapsed_seconds?.toFixed(1)}s
          </span>
        </div>
      )}

      {runStatus && runStatus.status === 'failed' && (
        <div className="run-failed">
          <span className="failed-icon">❌</span>
          <span>Run failed: {runStatus.error_message || 'Unknown error'}</span>
        </div>
      )}
    </div>
  )
}

export default RunNowButton
