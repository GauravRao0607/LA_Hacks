import { useEffect, useState } from 'react'
import {
  LifeBuoy, HeartPulse, Truck, Building2,
  UserSearch, Zap, AlertTriangle, X, CheckCircle
} from 'lucide-react'
import { TIER_COLORS } from '../data/constants'
import { VEHICLE_CONFIG } from '../data/vehicles'
import '../styles/Sidebar.css'

const TYPE_ICONS = {
  Rescue: LifeBuoy,
  Medical: HeartPulse,
  Evacuation: Truck,
  Structural: Building2,
  'Missing Person': UserSearch,
  Infrastructure: Zap,
}

function EtaCounter({ startTime, duration, status }) {
  const [label, setLabel] = useState('')
  useEffect(() => {
    if (status === 'on-scene') { setLabel('On scene'); return }
    const tick = () => {
      const rem = Math.max(0, duration - (Date.now() - startTime))
      const s   = Math.ceil(rem / 1000)
      setLabel(s > 0 ? `${s}s` : 'Arriving…')
    }
    tick()
    const id = setInterval(tick, 500)
    return () => clearInterval(id)
  }, [startTime, duration, status])
  return <span className={`ds-eta ${status === 'on-scene' ? 'arrived' : ''}`}>{label}</span>
}

function DispatchSection({ dispatches, onRecall }) {
  const entries = Object.values(dispatches)
  if (entries.length === 0) return null

  return (
    <div className="dispatch-section">
      <div className="dispatch-section-header">
        <span className="dispatch-section-title">Dispatches</span>
        <span className="dispatch-section-count">{entries.length}</span>
      </div>

      <div className="dispatch-list">
        {entries.map(d => {
          const allOnScene  = d.assignments.every(a => a.status === 'on-scene')
          const tierColor   = TIER_COLORS[d.incident.tier]

          return (
            <div key={d.incident.id} className={`ds-card ${allOnScene ? 'on-scene' : ''}`}>
              {/* Row 1: incident info */}
              <div className="ds-row ds-row-top">
                <div className="ds-tier-bar" style={{ background: tierColor }} />
                <div className="ds-info">
                  <span className="ds-type">{d.incident.type}</span>
                  <span className="ds-addr">{d.incident.address?.split(',')[0]}</span>
                </div>
                <div className="ds-status">
                  {allOnScene
                    ? <CheckCircle size={10} style={{ color: '#34d399' }} />
                    : <span className="ds-pulse" />}
                </div>
                <button className="ds-recall" onClick={() => onRecall(d.incident.id)} title="Recall">
                  <X size={9} />
                </button>
              </div>

              {/* Row 2: unit badges + ETAs */}
              <div className="ds-units">
                {d.assignments.map((a, i) => {
                  const cfg = VEHICLE_CONFIG[a.type]
                  return (
                    <div key={i} className={`ds-unit ${a.status}`}>
                      <span
                        className="ds-unit-badge"
                        style={{ color: cfg.color, background: cfg.color + '18', borderColor: cfg.color + '33' }}
                      >
                        {cfg.label}
                      </span>
                      <span className="ds-unit-name">{cfg.name}</span>
                      {a.startTime
                        ? <EtaCounter startTime={a.startTime} duration={a.duration} status={a.status} />
                        : <span className="ds-eta">Routing…</span>}
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function timeAgo(iso) {
  if (!iso) return ''
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  return `${Math.floor(m / 60)}h ago`
}

export default function Sidebar({ incidents = [], selectedId, onSelect, dispatches = {}, onRecall }) {
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 10000)
    return () => clearInterval(id)
  }, [])

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <div className="sidebar-header-row">
          <div className="sidebar-heading">Incidents</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="sidebar-count">{incidents.length}</span>
            <div className="live-badge">
              <div className="live-dot" />
              <span className="live-text">Live</span>
            </div>
          </div>
        </div>
      </div>

      <div className="incident-list">
        {incidents.length === 0 && (
          <div style={{ padding: '32px 16px', color: '#2d3748', fontSize: 12, textAlign: 'center' }}>
            Waiting for calls…
          </div>
        )}
        {incidents.map(incident => {
          const isSelected = selectedId === incident.id
          const tierColor  = TIER_COLORS[incident.tier]
          const Icon       = TYPE_ICONS[incident.type] || AlertTriangle
          const isDispatched = !!dispatches[incident.id]

          return (
            <div
              key={incident.id}
              className={`incident-item ${isSelected ? 'selected ' + incident.tier.toLowerCase() : ''} ${isDispatched ? 'dispatched' : ''}`}
              style={{ '--tier': tierColor }}
              onClick={() => onSelect(incident)}
            >
              <div className="item-accent" />
              <div className="incident-icon"><Icon size={13} /></div>
              <div className="incident-info">
                <div className="incident-type">
                  {incident.type}
                  {incident.call_count > 1 && (
                    <span style={{ marginLeft: 5, fontSize: 9, opacity: 0.4 }}>×{incident.call_count}</span>
                  )}
                </div>
                <div className="incident-address">{incident.address}</div>
              </div>
              <div className="incident-meta">
                {isDispatched
                  ? <span className="dispatched-badge">●</span>
                  : <div className="tier-dot" />}
                <div className="time-ago">{timeAgo(incident.created_at)}</div>
              </div>
            </div>
          )
        })}
      </div>

      <DispatchSection dispatches={dispatches} onRecall={onRecall} />
    </div>
  )
}
