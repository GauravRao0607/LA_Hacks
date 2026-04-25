import {
  LifeBuoy, HeartPulse, Truck, Building2,
  UserSearch, Zap, AlertTriangle
} from 'lucide-react'
import { TIER_COLORS } from '../data/constants'
import '../styles/Sidebar.css'

const TYPE_ICONS = {
  Rescue: LifeBuoy,
  Medical: HeartPulse,
  Evacuation: Truck,
  Structural: Building2,
  'Missing Person': UserSearch,
  Infrastructure: Zap,
}

function getTierClass(tier) {
  return tier.toLowerCase()
}

export default function Sidebar({ incidents = [], selectedId, onSelect }) {
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
          <div style={{
            padding: '32px 16px',
            color: '#2d3748',
            fontSize: 12,
            textAlign: 'center',
            letterSpacing: '0.04em',
          }}>
            Waiting for calls…
          </div>
        )}
        {incidents.map((incident) => {
          const isSelected = selectedId === incident.id
          const tierColor = TIER_COLORS[incident.tier]
          const Icon = TYPE_ICONS[incident.type] || AlertTriangle

          return (
            <div
              key={incident.id}
              className={`incident-item ${isSelected ? 'selected ' + getTierClass(incident.tier) : ''}`}
              style={{ '--tier': tierColor }}
              onClick={() => onSelect(incident)}
            >
              <div className="item-accent" />
              <div className="incident-icon">
                <Icon size={13} />
              </div>
              <div className="incident-info">
                <div className="incident-type">
                  {incident.type}
                  {incident.call_count > 1 && (
                    <span style={{ marginLeft: 5, fontSize: 9, opacity: 0.4 }}>
                      ×{incident.call_count}
                    </span>
                  )}
                </div>
                <div className="incident-address">{incident.address}</div>
              </div>
              <div className="incident-meta">
                <div className="tier-dot" />
                <div className="time-ago">{incident.timeAgo}</div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
