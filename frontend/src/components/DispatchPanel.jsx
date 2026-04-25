import { useEffect, useState } from 'react'
import { X, Radio, CheckCircle, Clock } from 'lucide-react'
import { VEHICLE_CONFIG } from '../data/vehicles'
import { TIER_COLORS } from '../data/constants'
import '../styles/DispatchPanel.css'

function Eta({ startTime, duration, status }) {
  const [label, setLabel] = useState('')

  useEffect(() => {
    if (status === 'on-scene') { setLabel('On scene'); return }
    const tick = () => {
      const elapsed  = Date.now() - startTime
      const remaining = Math.max(0, duration - elapsed)
      const secs = Math.ceil(remaining / 1000)
      setLabel(secs > 0 ? `${secs}s` : 'Arriving…')
    }
    tick()
    const id = setInterval(tick, 500)
    return () => clearInterval(id)
  }, [startTime, duration, status])

  return <span className={`dp-eta ${status === 'on-scene' ? 'arrived' : ''}`}>{label}</span>
}

export default function DispatchPanel({ dispatches, onRecall }) {
  const entries = Object.values(dispatches)
  if (entries.length === 0) return null

  return (
    <div className="dispatch-panel">
      <div className="dp-header">
        <Radio size={11} className="dp-header-icon" />
        <span>Active Dispatches</span>
        <span className="dp-count">{entries.length}</span>
      </div>

      <div className="dp-list">
        {entries.map(d => {
          const allOnScene = d.assignments.every(a => a.status === 'on-scene')
          return (
            <div key={d.incident.id} className={`dp-card ${allOnScene ? 'on-scene' : ''}`}>
              <div className="dp-card-header">
                <div className="dp-incident-dot" style={{ background: TIER_COLORS[d.incident.tier] }} />
                <span className="dp-incident-name">{d.incident.type}</span>
                <span className="dp-incident-addr">{d.incident.address?.split(',')[0]}</span>
                {allOnScene
                  ? <span className="dp-status-badge on-scene"><CheckCircle size={9} /> On scene</span>
                  : <span className="dp-status-badge en-route"><Clock size={9} /> En route</span>
                }
                <button className="dp-recall" onClick={() => onRecall(d.incident.id)} title="Recall units">
                  <X size={10} />
                </button>
              </div>

              <div className="dp-units">
                {d.assignments.map((a, i) => {
                  const cfg = VEHICLE_CONFIG[a.type]
                  return (
                    <div key={i} className={`dp-unit ${a.status}`}>
                      <span className="dp-unit-badge" style={{ background: cfg.color + '22', color: cfg.color, borderColor: cfg.color + '44' }}>
                        {cfg.label}
                      </span>
                      <span className="dp-unit-name">{cfg.name}</span>
                      {a.startTime
                        ? <Eta startTime={a.startTime} duration={a.duration} status={a.status} />
                        : <span className="dp-eta">Routing…</span>
                      }
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
