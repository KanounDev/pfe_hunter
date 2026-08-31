import { useState, useEffect } from 'react'
import { Routes, Route, Link, useLocation } from 'react-router-dom'
import Dashboard from './pages/Dashboard'
import Postings from './pages/Postings'
import Settings from './pages/Settings'
import { ThemeProvider } from './context/ThemeContext'
import './styles/Layout.css'

function App() {
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
