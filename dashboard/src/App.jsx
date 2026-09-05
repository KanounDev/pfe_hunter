import { useState, useEffect } from 'react'
import { Routes, Route, Link, useLocation } from 'react-router-dom'
import Dashboard from './pages/Dashboard'
import Postings from './pages/Postings'
import Settings from './pages/Settings'
import { ThemeProvider } from './context/ThemeContext'
import './styles/Layout.css'

function App() {
  const [accessToken, setAccessToken] = useState(() => {
    const queryToken = new URLSearchParams(window.location.search).get('token')
    if (queryToken) {
      sessionStorage.setItem('pfe_api_token', queryToken)
      return queryToken
    }
    return sessionStorage.getItem('pfe_api_token') || ''
  })
  const [tokenInput, setTokenInput] = useState('')
  const [theme, setTheme] = useState(() => {
    const saved = localStorage.getItem('theme')
    return saved || 'dark'
  })

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('theme', theme)
  }, [theme])

  const toggleTheme = () => {
    setTheme(prev => prev === 'dark' ? 'light' : 'dark')
  }

  const handleAccess = (event) => {
    event.preventDefault()
    const token = tokenInput.trim()
    if (!token) return
    sessionStorage.setItem('pfe_api_token', token)
    setAccessToken(token)
    setTokenInput('')
  }

  if (!accessToken) {
    return (
      <div className="access-gate">
        <div className="access-panel">
          <div className="access-mark">🔍</div>
          <p className="access-kicker">PFE HUNTER</p>
          <h1>Private dashboard</h1>
          <p>Enter your access token to continue.</p>
          <form onSubmit={handleAccess} className="access-form">
            <label htmlFor="access-token">Access token</label>
            <input
              id="access-token"
              type="password"
              value={tokenInput}
              onChange={(event) => setTokenInput(event.target.value)}
              placeholder="Paste your API token"
              autoComplete="off"
              autoFocus
            />
            <button type="submit">Open dashboard</button>
          </form>
        </div>
      </div>
    )
  }

  return (
    <ThemeProvider value={{ theme, toggleTheme }}>
      <div className="app">
        <header className="header">
          <div className="header-content">
            <Link to="/" className="logo">
              <span className="logo-icon">🔍</span>
              <span className="logo-text">PFE Hunter</span>
            </Link>
            <nav className="nav">
              <NavLink to="/">Dashboard</NavLink>
              <NavLink to="/postings">Job Postings</NavLink>
              <NavLink to="/settings">Settings</NavLink>
            </nav>
            <button className="theme-toggle" onClick={toggleTheme} aria-label="Toggle theme">
              {theme === 'dark' ? '☀️' : '🌙'}
            </button>
          </div>
        </header>

        <main className="main">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/postings" element={<Postings />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
        </main>

        <footer className="footer">
          <p>PFE Hunter © 2026 — Automated internship search assistant</p>
        </footer>
      </div>
    </ThemeProvider>
  )
}

function NavLink({ to, children }) {
  const location = useLocation()
  const isActive = location.pathname === to

  return (
    <Link
      to={to}
      className={`nav-link ${isActive ? 'nav-link-active' : ''}`}
    >
      {children}
    </Link>
  )
}

export default App
