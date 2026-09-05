import { useState, useEffect } from 'react'
import { getSettings, updateSettings, resetSettings, getCV, uploadCV, deleteCV } from '../api/api'
import { useToast } from '../components/Toast'
import '../styles/Settings.css'

function Settings() {
  const toast = useToast()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [hasChanges, setHasChanges] = useState(false)
  const [originalSettings, setOriginalSettings] = useState({})

  // Form state for each setting
  const [formData, setFormData] = useState({
    scrape_interval_minutes: 300,
    results_wanted: 10,
    hours_old: 336,
    fit_score_threshold: 70,
    search_terms: [],
    locations: [],
    job_sites: [],
    title_keywords: [],
    discord_webhook_url: ''
  })

  // Temporary input state for arrays
  const [newSearchTerm, setNewSearchTerm] = useState('')
  const [newLocation, setNewLocation] = useState('')
  const [newTitleKeyword, setNewTitleKeyword] = useState('')

  // CV Management state
  const [cv, setCV] = useState(null)
  const [cvLoading, setCVLoading] = useState(false)
  const [cvUploading, setCVUploading] = useState(false)

  useEffect(() => {
    fetchSettings()
    fetchCV()
  }, [])

  const fetchCV = async () => {
    try {
      setCVLoading(true)
      const data = await getCV()
      setCV(data.cv)
    } catch (err) {
      console.error('Failed to fetch CV:', err)
    } finally {
      setCVLoading(false)
    }
  }

  const handleCVUpload = async (event) => {
    const file = event.target.files[0]
    if (!file) return

    try {
      setCVUploading(true)
      setError(null)
      await uploadCV(file)
      await fetchCV()
      toast.success('CV uploaded successfully!')
    } catch (err) {
      setError('Failed to upload CV: ' + err.message)
      toast.error('Failed to upload CV: ' + err.message)
    } finally {
      setCVUploading(false)
      event.target.value = '' // Reset file input
    }
  }

  const handleCVDelete = async () => {
    if (!confirm('Are you sure you want to delete your CV?')) return

    try {
      setCVLoading(true)
      await deleteCV()
      setCV(null)
      toast.success('CV deleted successfully!')
    } catch (err) {
      setError('Failed to delete CV: ' + err.message)
      toast.error('Failed to delete CV: ' + err.message)
    } finally {
      setCVLoading(false)
    }
  }

  const fetchSettings = async () => {
    try {
      setLoading(true)
      const data = await getSettings()

      // Parse settings into form data
      const parsed = {
        scrape_interval_minutes: parseInt(data.scrape_interval_minutes?.value || 300),
        results_wanted: parseInt(data.results_wanted?.value || 10),
        hours_old: parseInt(data.hours_old?.value || 336),
        fit_score_threshold: parseInt(data.fit_score_threshold?.value || 70),
        search_terms: JSON.parse(data.search_terms?.value || '[]'),
        locations: JSON.parse(data.locations?.value || '[]'),
        job_sites: JSON.parse(data.job_sites?.value || '[]'),
        title_keywords: JSON.parse(data.title_keywords?.value || '[]'),
        discord_webhook_url: data.discord_webhook_url?.value || ''
      }

      setFormData(parsed)
      setOriginalSettings(parsed)
      setError(null)
    } catch (err) {
      setError('Failed to load settings: ' + err.message)
    } finally {
      setLoading(false)
    }
  }

  const handleChange = (key, value) => {
    setFormData(prev => ({ ...prev, [key]: value }))
    setHasChanges(true)
  }

  const handleArrayAdd = (key, value, setter) => {
    if (!value.trim()) return
    const currentArray = formData[key] || []
    if (!currentArray.includes(value.trim())) {
      handleChange(key, [...currentArray, value.trim()])
    }
    setter('')
  }

  const handleArrayRemove = (key, index) => {
    const newArray = formData[key].filter((_, i) => i !== index)
    handleChange(key, newArray)
  }

  const validate = () => {
    const errors = []

    if (formData.results_wanted < 1 || formData.results_wanted > 50) {
      errors.push('Results wanted must be between 1 and 50')
    }

    if (formData.hours_old < 1 || formData.hours_old > 336) {
      errors.push('Hours old must be between 1 and 336')
    }

    if (formData.scrape_interval_minutes < 5 || formData.scrape_interval_minutes > 10080) {
      errors.push('Pipeline interval must be between 5 minutes and 7 days')
    }

    if (formData.fit_score_threshold < 0 || formData.fit_score_threshold > 100) {
      errors.push('Fit score threshold must be between 0 and 100')
    }

    if (formData.search_terms.length === 0) {
      errors.push('At least one search term is required')
    }

    if (formData.locations.length === 0) {
      errors.push('At least one location is required')
    }

    if (formData.job_sites.length === 0) {
      errors.push('At least one job site must be selected')
    }

    if (formData.discord_webhook_url) {
      try {
        const webhook = new URL(formData.discord_webhook_url)
        if (webhook.protocol !== 'https:' || webhook.hostname !== 'discord.com') {
          errors.push('Discord webhook URL must be an HTTPS discord.com URL')
        }
      } catch {
        errors.push('Discord webhook URL must be valid')
      }
    }

    return errors
  }

  const handleSave = async () => {
    const errors = validate()
    if (errors.length > 0) {
      setError(errors.join('. '))
      return
    }

    try {
      setSaving(true)
      setError(null)

      const payload = {
        settings: {
          scrape_interval_minutes: formData.scrape_interval_minutes.toString(),
          results_wanted: formData.results_wanted.toString(),
          hours_old: formData.hours_old.toString(),
          fit_score_threshold: formData.fit_score_threshold.toString(),
          search_terms: JSON.stringify(formData.search_terms),
          locations: JSON.stringify(formData.locations),
          job_sites: JSON.stringify(formData.job_sites),
          title_keywords: JSON.stringify(formData.title_keywords),
          discord_webhook_url: formData.discord_webhook_url.trim()
        }
      }

      await updateSettings(payload)
      toast.success('Settings saved successfully!')
      setHasChanges(false)
      setOriginalSettings(formData)
    } catch (err) {
      setError('Failed to save settings: ' + err.message)
      toast.error('Failed to save settings: ' + err.message)
    } finally {
      setSaving(false)
    }
  }

  const handleReset = () => {
    setFormData(originalSettings)
    setHasChanges(false)
    setError(null)
  }

  const handleResetToDefaults = async () => {
    if (!confirm('Reset all settings to default values?')) return

    try {
      setSaving(true)
      await resetSettings()
      await fetchSettings()
      toast.success('Settings reset to defaults!')
      setHasChanges(false)
    } catch (err) {
      setError('Failed to reset settings: ' + err.message)
      toast.error('Failed to reset settings: ' + err.message)
    } finally {
      setSaving(false)
    }
  }

  const jobSiteOptions = [
    { value: 'linkedin', label: 'LinkedIn' },
    { value: 'indeed', label: 'Indeed' },
    { value: 'jobteaser', label: 'JobTeaser' }
  ]

  if (loading) {
    return (
      <div className="settings-page">
        <div className="settings-loading">Loading settings...</div>
      </div>
    )
  }

  return (
    <div className="settings-page">
      <div className="settings-header">
        <h1>⚙️ Settings</h1>
        <p className="settings-subtitle">Configure your job scraping and scoring preferences</p>
      </div>

      {error && (
        <div className="settings-error">
          <span className="error-icon">⚠️</span>
          {error}
        </div>
      )}

      <div className="settings-grid">
        {/* Scrape Configuration */}
        <section className="settings-section">
          <h2>📅 Scrape Configuration</h2>

          <div className="setting-info-box">
            <h3>⏰ Scheduling</h3>
            <p>
              GitHub Actions checks for work every 5 minutes. The pipeline runs when this
              interval has elapsed since the previous run.
            </p>
            <p>
              Need results sooner? Use the <strong>▶️ Run Now</strong> button on the Dashboard
              to trigger a manual run.
            </p>
          </div>

          <div className="setting-item">
            <label htmlFor="scrape_interval_minutes">
              Pipeline Interval
              <span className="setting-description">Minimum time between automatic pipeline runs</span>
            </label>
            <input
              id="scrape_interval_minutes"
              type="number"
              min="5"
              max="10080"
              value={formData.scrape_interval_minutes}
              onChange={(e) => handleChange('scrape_interval_minutes', parseInt(e.target.value) || 5)}
              className="setting-input"
            />
            <span className="setting-hint">5 minutes to 7 days. The workflow polls every 5 minutes.</span>
          </div>

          <div className="setting-item">
            <label htmlFor="results_wanted">
              Results per Source
              <span className="setting-description">Number of job postings to fetch per source per run</span>
            </label>
            <input
              id="results_wanted"
              type="number"
              min="1"
              max="50"
              value={formData.results_wanted}
              onChange={(e) => handleChange('results_wanted', parseInt(e.target.value) || 1)}
              className="setting-input"
            />
            <span className="setting-hint">Max: 50 to avoid rate limits</span>
          </div>

          <div className="setting-item">
            <label htmlFor="hours_old">
              Hours Old
              <span className="setting-description">Only fetch jobs posted within this many hours</span>
            </label>
            <input
              id="hours_old"
              type="number"
              min="1"
              max="336"
              value={formData.hours_old}
              onChange={(e) => handleChange('hours_old', parseInt(e.target.value) || 1)}
              className="setting-input"
            />
            <span className="setting-hint">Max: 336 (14 days)</span>
          </div>
        </section>

        {/* Notifications Configuration */}
        <section className="settings-section">
          <h2>🔔 Notifications</h2>

          <div className="setting-item">
            <label htmlFor="discord_webhook_url">
              Discord Webhook URL
              <span className="setting-description">Used by the pipeline to send matching-job and failure alerts</span>
            </label>
            <input
              id="discord_webhook_url"
              type="url"
              placeholder="https://discord.com/api/webhooks/..."
              value={formData.discord_webhook_url}
              onChange={(e) => handleChange('discord_webhook_url', e.target.value)}
              className="setting-input"
            />
            <span className="setting-hint">Leave empty to disable Discord notifications. Saved securely in the database.</span>
          </div>
        </section>

        {/* AI Scoring Configuration */}
        <section className="settings-section">
          <h2>🎯 AI Scoring</h2>

          <div className="setting-item">
            <label htmlFor="fit_score_threshold">
              Fit Score Threshold
              <span className="setting-description">Minimum score to trigger Discord notification (0-100)</span>
            </label>
            <input
              id="fit_score_threshold"
              type="number"
              min="0"
              max="100"
              value={formData.fit_score_threshold}
              onChange={(e) => handleChange('fit_score_threshold', parseInt(e.target.value) || 0)}
              className="setting-input"
            />
            <span className="setting-hint">Jobs with score ≥ threshold trigger alerts</span>
          </div>

          <div className="setting-info-box">
            <h3>📊 About Fit Score</h3>
            <p>
              The fit score is calculated by Gemini AI based on how well the job matches your CV.
              It considers:
            </p>
            <ul>
              <li>Skills match between job requirements and your CV</li>
              <li>Experience level alignment</li>
              <li>Location and role type preferences</li>
              <li>Key technologies and frameworks</li>
            </ul>
            <p className="rate-limit-info">
              <strong>Rate Limit:</strong> Gemini API allows 100-1000 requests per day (RPD)
            </p>
          </div>
        </section>

        {/* Search Configuration */}
        <section className="settings-section">
          <h2>🔍 Search Terms</h2>

          <div className="setting-item">
            <label>
              Search Terms
              <span className="setting-description">Keywords to search for job postings</span>
            </label>
            <div className="array-input-group">
              <input
                type="text"
                placeholder="e.g., software engineering internship"
                value={newSearchTerm}
                onChange={(e) => setNewSearchTerm(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && handleArrayAdd('search_terms', newSearchTerm, setNewSearchTerm)}
                className="setting-input"
              />
              <button
                className="btn-add"
                onClick={() => handleArrayAdd('search_terms', newSearchTerm, setNewSearchTerm)}
              >
                Add
              </button>
            </div>
            <div className="array-tags">
              {formData.search_terms.map((term, index) => (
                <span key={index} className="tag">
                  {term}
                  <button onClick={() => handleArrayRemove('search_terms', index)}>&times;</button>
                </span>
              ))}
            </div>
          </div>

          <div className="setting-item">
            <label>
              Locations
              <span className="setting-description">Geographic locations to search in</span>
            </label>
            <div className="array-input-group">
              <input
                type="text"
                placeholder="e.g., France, Paris, Remote"
                value={newLocation}
                onChange={(e) => setNewLocation(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && handleArrayAdd('locations', newLocation, setNewLocation)}
                className="setting-input"
              />
              <button
                className="btn-add"
                onClick={() => handleArrayAdd('locations', newLocation, setNewLocation)}
              >
                Add
              </button>
            </div>
            <div className="array-tags">
              {formData.locations.map((loc, index) => (
                <span key={index} className="tag">
                  {loc}
                  <button onClick={() => handleArrayRemove('locations', index)}>&times;</button>
                </span>
              ))}
            </div>
          </div>
        </section>

        {/* Job Sites Configuration */}
        <section className="settings-section">
          <h2>🌐 Job Sites</h2>

          <div className="setting-item">
            <label>
              Active Job Sites
              <span className="setting-description">Select which job boards to scrape</span>
            </label>
            <div className="checkbox-group">
              {jobSiteOptions.map(option => (
                <label key={option.value} className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={formData.job_sites.includes(option.value)}
                    onChange={(e) => {
                      const newSites = e.target.checked
                        ? [...formData.job_sites, option.value]
                        : formData.job_sites.filter(s => s !== option.value)
                      handleChange('job_sites', newSites)
                    }}
                  />
                  <span>{option.label}</span>
                </label>
              ))}
            </div>
            <span className="setting-hint">JobTeaser requires custom implementation</span>
          </div>

          <div className="setting-item">
            <label>
              Title Keywords Filter
              <span className="setting-description">Only include jobs with these keywords in the title</span>
            </label>
            <div className="array-input-group">
              <input
                type="text"
                placeholder="e.g., software, developer, intern"
                value={newTitleKeyword}
                onChange={(e) => setNewTitleKeyword(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && handleArrayAdd('title_keywords', newTitleKeyword, setNewTitleKeyword)}
                className="setting-input"
              />
              <button
                className="btn-add"
                onClick={() => handleArrayAdd('title_keywords', newTitleKeyword, setNewTitleKeyword)}
              >
                Add
              </button>
            </div>
            <div className="array-tags">
              {formData.title_keywords.map((keyword, index) => (
                <span key={index} className="tag">
                  {keyword}
                  <button onClick={() => handleArrayRemove('title_keywords', index)}>&times;</button>
                </span>
              ))}
            </div>
            <span className="setting-hint">Leave empty to skip title filtering</span>
          </div>
        </section>

        {/* CV Management */}
        <section className="settings-section">
          <h2>📄 CV Management</h2>

          <div className="setting-item">
            <label>
              Current CV
              <span className="setting-description">
                Upload your CV for AI-powered job matching — saved immediately, no need to click "Save Changes"
              </span>
            </label>

            {cvLoading ? (
              <div className="cv-loading">Loading CV info...</div>
            ) : cv ? (
              <div className="cv-info">
                <div className="cv-details">
                  <span className="cv-icon">📄</span>
                  <div className="cv-meta">
                    <div className="cv-filename">{cv.original_name}</div>
                    <div className="cv-stats">
                      Size: {(cv.file_size / 1024).toFixed(1)} KB •
                      Uploaded: {new Date(cv.uploaded_at).toLocaleDateString()}
                    </div>
                  </div>
                </div>
                <div className="cv-actions">
                  <label className="btn-secondary btn-cv">
                    📤 Replace
                    <input
                      type="file"
                      accept=".pdf,application/pdf"
                      onChange={handleCVUpload}
                      style={{ display: 'none' }}
                      disabled={cvUploading}
                    />
                  </label>
                  <button
                    className="btn-danger"
                    onClick={handleCVDelete}
                    disabled={cvUploading}
                  >
                    🗑️ Delete
                  </button>
                </div>
              </div>
            ) : (
              <div className="cv-upload">
                <label className="cv-upload-btn">
                  <span className="cv-upload-icon">📤</span>
                  <span className="cv-upload-text">
                    {cvUploading ? 'Uploading...' : 'Upload CV'}
                  </span>
                  <span className="cv-upload-hint">PDF only (max 10MB)</span>
                  <input
                    type="file"
                    accept=".pdf,application/pdf"
                    onChange={handleCVUpload}
                    style={{ display: 'none' }}
                    disabled={cvUploading}
                  />
                </label>
              </div>
            )}
          </div>

          <div className="setting-info-box">
            <h3>💡 CV Tips</h3>
            <ul>
              <li>Use PDF format for best compatibility</li>
              <li>Include specific technologies and frameworks</li>
              <li>Quantify achievements (e.g., "Improved performance by 40%")</li>
              <li>Keep it updated with recent projects</li>
            </ul>
          </div>
        </section>
      </div>

      {/* Action Buttons */}
      <div className="settings-actions">
        <button
          className="btn-primary"
          onClick={handleSave}
          disabled={!hasChanges || saving}
        >
          {saving ? 'Saving...' : 'Save Changes'}
        </button>
        <button
          className="btn-secondary"
          onClick={handleReset}
          disabled={!hasChanges || saving}
        >
          Reset Changes
        </button>
        <button
          className="btn-danger"
          onClick={handleResetToDefaults}
          disabled={saving}
        >
          Reset to Defaults
        </button>
      </div>
    </div>
  )
}

export default Settings
