import {
  LifeBuoy, HeartPulse, Truck, Building2,
  UserSearch, Zap, AlertTriangle
} from 'lucide-react'
import { MOCK_INCIDENTS, TIER_COLORS } from '../data/mockIncidents'
import '../styles/Sidebar.css'

const sorted = [...MOCK_INCIDENTS].sort((a, b) => b.score - a.score)
const criticalCount = MOCK_INCIDENTS.filter(i => i.tier === 'Critical').length
const urgentCount = MOCK_INCIDENTS.filter(i => i.tier === 'Urgent').length

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

function getScoreBg(tier) {
  const map = {
    Critical: 'rgba(244,63,94,0.15)',
    Urgent: 'rgba(249,115,22,0.15)',
    Standard: 'rgba(251,191,36,0.12)',
  }
  return map[tier] || 'rgba(255,255,255,0.08)'
}

export default function Sidebar({ selectedId, onSelect }) {
  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <div className="sidebar-header-row">
          <div className="sidebar-heading">Call Queue</div>
          <div className="live-badge">
            <div className="live-dot" />
            <span className="live-text">Live</span>
          </div>
        </div>
        <div className="stats-row">
          <div className="stat-card total">
            <div className="stat-value">{MOCK_INCIDENTS.length}</div>
            <div className="stat-label">Total</div>
          </div>
          <div className="stat-card critical">
            <div className="stat-value">{criticalCount}</div>
            <div className="stat-label">Critical</div>
          </div>
          <div className="stat-card urgent">
            <div className="stat-value">{urgentCount}</div>
            <div className="stat-label">Urgent</div>
          </div>
        </div>
      </div>

      <div className="queue-header">
        <div className="queue-title">Priority Queue</div>
        <div className="queue-count-badge">{sorted.length} reports</div>
      </div>

      <div className="incident-list">
        {sorted.map((incident) => {
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
                <Icon size={14} />
              </div>
              <div className="incident-info">
                <div className="incident-type">{incident.type}</div>
                <div className="incident-address">{incident.address}</div>
              </div>
              <div className="incident-meta">
                <div
                  className="score-badge"
                  style={{
                    color: tierColor,
                    background: getScoreBg(incident.tier),
                    border: `1px solid ${tierColor}33`,
                  }}
                >
                  {incident.score}
                </div>
                <div className="time-ago">{incident.timeAgo}</div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
