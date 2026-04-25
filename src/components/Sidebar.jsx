import { MOCK_INCIDENTS, TIER_COLORS } from '../data/mockIncidents'
import '../styles/Sidebar.css'

const sorted = [...MOCK_INCIDENTS].sort((a, b) => b.score - a.score)

const criticalCount = MOCK_INCIDENTS.filter(i => i.tier === 'Critical').length
const urgentCount = MOCK_INCIDENTS.filter(i => i.tier === 'Urgent').length

function getTierClass(tier) {
  return tier.toLowerCase()
}

function getScoreBgColor(tier) {
  const map = { Critical: 'rgba(255,59,48,0.2)', Urgent: 'rgba(255,149,0,0.2)', Standard: 'rgba(255,204,0,0.18)' }
  return map[tier] || 'rgba(255,255,255,0.1)'
}

export default function Sidebar({ selectedId, onSelect }) {
  return (
    <div className="sidebar">
      {/* Header */}
      <div className="sidebar-header">
        <div className="sidebar-brand">
          <div className="brand-name">CrisisLine</div>
          <div className="live-badge">
            <div className="live-dot" />
            <span className="live-text">Live</span>
          </div>
        </div>

        <div className="stats-row">
          <div className="stat-card total">
            <div className="stat-value">{MOCK_INCIDENTS.length}</div>
            <div className="stat-label">Active</div>
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

      {/* Queue header */}
      <div className="queue-header">
        <div className="queue-title">Priority Queue</div>
        <div className="queue-count-badge">{sorted.length} incidents</div>
      </div>

      {/* List */}
      <div className="incident-list">
        {sorted.map((incident, idx) => {
          const isSelected = selectedId === incident.id
          const tierColor = TIER_COLORS[incident.tier]
          return (
            <div
              key={incident.id}
              className={`incident-item ${isSelected ? 'selected ' + getTierClass(incident.tier) : ''}`}
              onClick={() => onSelect(incident)}
            >
              <span className="rank-num">{idx + 1}</span>
              <div
                className="tier-dot"
                style={{
                  background: tierColor,
                  boxShadow: `0 0 6px ${tierColor}`,
                }}
              />
              <div className="incident-info">
                <div className="incident-type">{incident.type}</div>
                <div className="incident-address">{incident.address}</div>
              </div>
              <div className="incident-meta">
                <div
                  className="score-badge"
                  style={{
                    color: tierColor,
                    background: getScoreBgColor(incident.tier),
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
