import { useState, useEffect } from 'react'
import '../styles/TopBar.css'

export default function TopBar() {
  const [time, setTime] = useState(new Date())

  useEffect(() => {
    const id = setInterval(() => setTime(new Date()), 1000)
    return () => clearInterval(id)
  }, [])

  const formatTime = (d) => {
    return d.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })
  }

  const formatDate = (d) => {
    return d.toLocaleDateString('en-US', {
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    }).toUpperCase()
  }

  return (
    <div className="topbar">
      <div className="topbar-left">
        <div className="topbar-logo">
          <span>Crisis</span>Line
        </div>
        <div className="topbar-separator" />
        <div className="topbar-subtitle">AI Dispatch System</div>
      </div>

      <div className="topbar-center">
        <div className="topbar-time">{formatTime(time)}</div>
        <div className="topbar-date">{formatDate(time)}</div>
      </div>

      <div className="topbar-right">
        <div className="queue-counter">
          <span className="queue-counter-label">Calls in Queue</span>
          <span className="queue-counter-value">12</span>
        </div>
        <div className="operator-status">
          <div className="status-dot" />
          <span className="operator-label">Operator Active</span>
        </div>
      </div>
    </div>
  )
}
