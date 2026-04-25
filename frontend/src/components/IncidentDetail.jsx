import {
  X, MapPin, Clock, TrendingUp, Hash, Users,
  LifeBuoy, HeartPulse, Truck, Building2,
  UserSearch, Zap, AlertTriangle,
  Radio, CheckCircle, MessageSquareQuote
} from 'lucide-react'
import { TIER_COLORS } from '../data/constants'
import { API_URL, API_HEADERS } from '../hooks/useIncidents'
import '../styles/IncidentDetail.css'

const TYPE_ICONS = {
  Rescue: LifeBuoy,
  Medical: HeartPulse,
  Evacuation: Truck,
  Structural: Building2,
  'Missing Person': UserSearch,
  Infrastructure: Zap,
}

const RESPONDER_LABEL = { fire: 'Fire', ems: 'EMS', police: 'Police', rescue: 'Rescue' }

export default function IncidentDetail({ incident, onClose }) {
  if (!incident) return null

  const tierColor = TIER_COLORS[incident.tier]
  const Icon = TYPE_ICONS[incident.type] || AlertTriangle

  async function handleResolve() {
    try {
      await fetch(`${API_URL}/incidents/${incident.id}`, {
        method: 'DELETE',
        headers: API_HEADERS,
      })
      onClose()
    } catch (e) {
      console.error('Resolve failed', e)
    }
  }

  const responders = incident.required_responders || {}
  const respList = Object.entries(responders).filter(([, v]) => v > 0)
  const reportId = String(incident.id).slice(0, 8).toUpperCase()

  return (
    <div className="incident-detail-overlay">
      <div className="incident-detail-card">
        <div className="detail-header" style={{ '--tier-color': tierColor }}>
          <div className="detail-header-left">
            <div className="detail-icon" style={{ '--tier-color': tierColor }}>
              <Icon size={16} />
            </div>
            <div className="detail-title-block">
              <div className="detail-type">{incident.type}</div>
              <div className="detail-tier-badge" style={{ '--tier-color': tierColor }}>
                <span className="tier-dot-sm" />
                {incident.tier}
              </div>
            </div>
          </div>
          <button className="close-btn" onClick={onClose}>
            <X size={12} />
          </button>
        </div>

        <div className="detail-body">
          <div className="detail-description" style={{ '--tier': `${tierColor}40` }}>
            {incident.description}
          </div>

          {incident.situation && (
            <div style={{
              margin: '10px 0 4px',
              padding: '8px 12px',
              borderRadius: 6,
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.08)',
              fontSize: 12,
              color: 'rgba(255,255,255,0.65)',
              fontStyle: 'italic',
              display: 'flex',
              gap: 8,
              alignItems: 'flex-start',
            }}>
              <MessageSquareQuote size={13} style={{ marginTop: 1, flexShrink: 0, color: tierColor }} />
              "{incident.situation}"
            </div>
          )}

          <div className="detail-fields">
            <div className="detail-field">
              <div className="detail-field-label"><MapPin size={10} /> Location</div>
              <div className="detail-field-value">{incident.address}</div>
            </div>

            <div className="detail-field">
              <div className="detail-field-label"><Clock size={10} /> Reported</div>
              <div className="detail-field-value">{incident.timeAgo}</div>
            </div>

            {incident.people != null && incident.people > 0 && (
              <div className="detail-field">
                <div className="detail-field-label"><Users size={10} /> People</div>
                <div className="detail-field-value">{incident.people}</div>
              </div>
            )}

            {incident.call_count > 1 && (
              <div className="detail-field">
                <div className="detail-field-label"><Radio size={10} /> Calls</div>
                <div className="detail-field-value">{incident.call_count} clustered</div>
              </div>
            )}

            <div className="detail-field">
              <div className="detail-field-label"><TrendingUp size={10} /> Priority</div>
              <div className="score-meter">
                <div className="score-bar-track">
                  <div
                    className="score-bar-fill"
                    style={{ width: `${incident.score}%`, background: tierColor }}
                  />
                </div>
                <span className="score-number" style={{ color: tierColor }}>{incident.score}</span>
              </div>
            </div>

            <div className="detail-field">
              <div className="detail-field-label"><Hash size={10} /> Report</div>
              <div className="detail-field-value mono">RPT-{reportId}</div>
            </div>
          </div>

          {respList.length > 0 && (
            <>
              <div className="detail-divider" />
              <div className="responders-label">Responders needed</div>
              <div className="responders-list">
                {respList.map(([k, v]) => (
                  <div key={k} className="responder-chip">
                    <strong>{v}</strong> {RESPONDER_LABEL[k] || k}
                  </div>
                ))}
              </div>
            </>
          )}

          <div className="detail-divider" />

          <div className="detail-actions">
            <button className="action-btn dispatch">
              <Radio size={12} />
              Dispatch
            </button>
            <button className="action-btn resolve" onClick={handleResolve}>
              <CheckCircle size={12} />
              Resolve
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
