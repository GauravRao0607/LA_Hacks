import { useState, useEffect } from 'react'
import { CloudLightning, ShieldAlert, Radio, Network } from 'lucide-react'
import '../styles/TopBar.css'

export default function TopBar({ incidents = [], showGraph, onGraphToggle }) {
  const [time, setTime] = useState(new Date())

  useEffect(() => {
    const id = setInterval(() => setTime(new Date()), 1000)
    return () => clearInterval(id)
  }, [])

  const formatTime = (d) =>
    d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })

  const critical = incidents.filter(i => i.tier === 'Critical').length
  const urgent   = incidents.filter(i => i.tier === 'Urgent').length
  const total    = incidents.length

  return (
    <div className="topbar">
      <div className="topbar-left">
        <div className="topbar-logo">
          <CloudLightning size={13} className="topbar-logo-icon" />
          <span className="logo-storm">Crisis</span>Line AI
        </div>
        <div className="topbar-separator" />
        <div className="topbar-time">{formatTime(time)}</div>
      </div>

      <div className="topbar-center">
        {total > 0 ? (
          <>
            <div className="event-alert-dot" />
            <div className="event-name">{total} Active Incident{total !== 1 ? 's' : ''}</div>
            {critical > 0 && (
              <>
                <div className="topbar-center-sep" />
                <div className="event-meta" style={{ color: '#F43F5E' }}>{critical} Critical</div>
              </>
            )}
            {urgent > 0 && (
              <>
                <div className="event-meta-sep">·</div>
                <div className="event-meta" style={{ color: '#F97316' }}>{urgent} Urgent</div>
              </>
            )}
          </>
        ) : (
          <div className="event-meta" style={{ opacity: 0.4 }}>No active incidents</div>
        )}
      </div>

      <div className="topbar-right">
        {critical > 0 && (
          <div className="stat-pill critical">
            <ShieldAlert size={10} />
            <span>{critical} Critical</span>
          </div>
        )}
        <div className="stat-pill">
          <Radio size={10} />
          <span>{total} Reports</span>
        </div>

        <button
          className={`graph-toggle-btn ${showGraph ? 'active' : ''}`}
          onClick={onGraphToggle}
          title="Knowledge Graph"
        >
          <Network size={13} />
        </button>

        <div className="topbar-separator" />
        <div className="system-status">
          <div className="status-dot" />
          <span className="system-label">Live</span>
        </div>
      </div>
    </div>
  )
}
