import { useState, useEffect } from 'react'
import { CloudLightning, Wind, ShieldAlert } from 'lucide-react'
import { PRIMARY_EVENT, MOCK_INCIDENTS } from '../data/mockIncidents'
import '../styles/TopBar.css'

const criticalCount = MOCK_INCIDENTS.filter(i => i.tier === 'Critical').length

export default function TopBar() {
  const [time, setTime] = useState(new Date())

  useEffect(() => {
    const id = setInterval(() => setTime(new Date()), 1000)
    return () => clearInterval(id)
  }, [])

  const formatTime = (d) =>
    d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })

  return (
    <div className="topbar">
      <div className="topbar-left">
        <div className="topbar-logo">
          <CloudLightning size={15} className="topbar-logo-icon" />
          <span className="logo-storm">Storm</span>Watch
        </div>
        <div className="topbar-separator" />
        <div className="topbar-time">{formatTime(time)}</div>
      </div>

      <div className="topbar-center">
        <div className="event-alert-dot" />
        <div className="event-category">{PRIMARY_EVENT.category}</div>
        <div className="event-name">{PRIMARY_EVENT.name}</div>
        <div className="topbar-center-sep" />
        <div className="event-meta">{PRIMARY_EVENT.location}</div>
        <div className="event-meta-sep">·</div>
        <div className="event-meta">{PRIMARY_EVENT.windSpeed}</div>
        <div className="event-meta-sep">·</div>
        <div className="event-elapsed">{PRIMARY_EVENT.elapsed} active</div>
      </div>

      <div className="topbar-right">
        <div className="stat-pill critical">
          <ShieldAlert size={11} />
          <span>{criticalCount} Critical</span>
        </div>
        <div className="stat-pill">
          <Wind size={11} />
          <span>{MOCK_INCIDENTS.length} Reports</span>
        </div>
        <div className="system-status">
          <div className="status-dot" />
          <span className="system-label">Online</span>
        </div>
      </div>
    </div>
  )
}
