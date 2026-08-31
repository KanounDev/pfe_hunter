function StatCard({ title, value, icon, subtitle, change, changeType, extra }) {
  return (
    <div className="stat-card">
      <div className="stat-card-header">
        <div className="stat-card-icon">{icon}</div>
        <span className="stat-card-title">{title}</span>
        {extra}
      </div>
      <div className="stat-card-value">{value}</div>
      {subtitle && <p className="stat-card-subtitle">{subtitle}</p>}
      {change && (
        <p className={`stat-card-change ${changeType === 'positive' ? 'stat-card-change-positive' : 'stat-card-change-negative'}`}>
          {change}
        </p>
      )}
    </div>
  )
}

export default StatCard
