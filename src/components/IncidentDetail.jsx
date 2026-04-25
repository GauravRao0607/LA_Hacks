import { X, MapPin, Clock, AlertTriangle, CheckCircle, TrendingUp } from 'lucide-react'
import { TIER_COLORS } from '../data/mockIncidents'
import '../styles/IncidentDetail.css'

const TYPE_ICONS = {
  Medical: '🚑',
  Fire: '🔥',
  Crime: '🚨',
  Accident: '🚗',
  Noise: '🔊',
}

const TYPE_BG = {
  Medical: 'rgba(48,209,88,0.12)',
  Fire: 'rgba(255,59,48,0.12)',
  Crime: 'rgba(255,59,48,0.12)',
  Accident: 'rgba(255,149,0,0.12)',
  Noise: 'rgba(139,143,168,0.12)',
}

export default function IncidentDetail({ incident, onClose }) {
  if (!incident) return null

  const tierColor = TIER_COLORS[incident.tier]

  return (
    <div className="incident-detail-overlay">
      <div className="incident-detail-card">
        {/* Header */}
        <div className="detail-header">
          <div className="detail-header-left">
            <div
              className="detail-icon"
              style={{ background: TYPE_BG[incident.type] || 'rgba(255,255,255,0.06)' }}
            >
              {TYPE_ICONS[incident.type] || '⚡'}
            </div>
            <div className="detail-title-block">
              <div className="detail-type">{incident.type} Incident</div>
              <div
                className="detail-tier-badge"
                style={{
                  background: `${tierColor}22`,
                  color: tierColor,
                  border: `1px solid ${tierColor}55`,
                }}
              >
                <span style={{
                  width: 5, height: 5, borderRadius: '50%',
                  background: tierColor,
                  boxShadow: `0 0 4px ${tierColor}`,
                  display: 'inline-block',
                }} />
                {incident.tier}
              </div>
            </div>
          </div>

          <button className="close-btn" onClick={onClose}>
            <X size={14} />
          </button>
        </div>

        {/* Body */}
        <div className="detail-body">
          <div
            className="detail-description"
            style={{ '--tier-color': tierColor }}
          >
            {incident.description}
          </div>

          <div className="detail-fields">
            <div className="detail-field">
              <div className="detail-field-label">
                <MapPin size={11} />
                Location
              </div>
              <div className="detail-field-value">{incident.address}</div>
            </div>

            <div className="detail-field">
              <div className="detail-field-label">
                <Clock size={11} />
                Time in Queue
              </div>
              <div className="detail-field-value">{incident.timeAgo}</div>
            </div>

            <div className="detail-field">
              <div className="detail-field-label">
                <TrendingUp size={11} />
                Threat Score
              </div>
              <div className="score-meter">
                <div className="score-bar-track">
                  <div
                    className="score-bar-fill"
                    style={{
                      width: `${incident.score}%`,
                      background: tierColor,
                      boxShadow: `0 0 4px ${tierColor}`,
                    }}
                  />
                </div>
                <span className="score-number" style={{ color: tierColor }}>
                  {incident.score}
                </span>
              </div>
            </div>

            <div className="detail-field">
              <div className="detail-field-label">
                <AlertTriangle size={11} />
                Incident ID
              </div>
              <div className="detail-field-value" style={{ color: '#8B8FA8', fontFamily: 'monospace' }}>
                INC-{String(incident.id).padStart(4, '0')}
              </div>
            </div>
          </div>

          <div className="detail-divider" />

          <div className="detail-actions">
            <button className="action-btn dispatch">
              <CheckCircle size={13} />
              Dispatch
            </button>
            <button className="action-btn escalate">
              <AlertTriangle size={13} />
              Escalate
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
