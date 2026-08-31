import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'

function ScoreChart({ data }) {
  const chartData = Object.entries(data).map(([range, count]) => ({
    range,
    count,
  }))

  return (
    <ResponsiveContainer width="100%" height={280}>
      <BarChart data={chartData} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" />
        <XAxis
          dataKey="range"
          tick={{ fill: 'var(--text-secondary)', fontSize: 12 }}
          stroke="var(--border-color)"
        />
        <YAxis
          tick={{ fill: 'var(--text-secondary)', fontSize: 12 }}
          stroke="var(--border-color)"
          allowDecimals={false}
        />
        <Tooltip
          contentStyle={{
            backgroundColor: 'var(--bg-secondary)',
            border: '1px solid var(--border-color)',
            borderRadius: 'var(--radius-md)',
            color: 'var(--text-primary)',
          }}
          labelStyle={{ color: 'var(--text-secondary)' }}
        />
        <Bar
          dataKey="count"
          fill="var(--accent)"
          radius={[4, 4, 0, 0]}
        />
      </BarChart>
    </ResponsiveContainer>
  )
}

export default ScoreChart
