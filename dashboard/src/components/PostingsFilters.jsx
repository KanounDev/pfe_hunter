function PostingsFilters({ filters, onChange }) {
  const handleChange = (key, value) => {
    onChange({ ...filters, [key]: value })
  }

  return (
    <div className="filters">
      <div className="filters-row">
        {/* Fit Score Range */}
        <div className="filter-group">
          <label className="filter-label">Fit Score Range</label>
          <div className="range-inputs">
            <input
              type="number"
              className="input range-input"
              placeholder="Min"
              min="0"
              max="100"
              value={filters.minScore}
              onChange={(e) => handleChange('minScore', parseInt(e.target.value) || 0)}
            />
            <span className="range-separator">—</span>
            <input
              type="number"
              className="input range-input"
              placeholder="Max"
              min="0"
              max="100"
              value={filters.maxScore}
              onChange={(e) => handleChange('maxScore', parseInt(e.target.value) || 100)}
            />
          </div>
        </div>

        {/* Company */}
        <div className="filter-group">
          <label className="filter-label">Company</label>
          <input
            type="text"
            className="input"
            placeholder="Search company..."
            value={filters.company}
            onChange={(e) => handleChange('company', e.target.value)}
          />
        </div>

        {/* Location */}
        <div className="filter-group">
          <label className="filter-label">Location</label>
          <input
            type="text"
            className="input"
            placeholder="Search location..."
            value={filters.location}
            onChange={(e) => handleChange('location', e.target.value)}
          />
        </div>

        {/* Notified Status */}
        <div className="filter-group">
          <label className="filter-label">Notification Status</label>
          <select
            className="select"
            value={filters.notified}
            onChange={(e) => handleChange('notified', e.target.value)}
          >
            <option value="all">All</option>
            <option value="notified">Notified</option>
            <option value="not-notified">Not Notified</option>
          </select>
        </div>
      </div>

      {/* Score Slider */}
      <div className="filter-group-full">
        <label className="filter-label">
          Fit Score: {filters.minScore} - {filters.maxScore}
        </label>
        <input
          type="range"
          className="slider"
          min="0"
          max="100"
          value={filters.minScore}
          onChange={(e) => handleChange('minScore', parseInt(e.target.value))}
        />
        <input
          type="range"
          className="slider"
          min="0"
          max="100"
          value={filters.maxScore}
          onChange={(e) => handleChange('maxScore', parseInt(e.target.value))}
        />
      </div>
    </div>
  )
}

export default PostingsFilters
