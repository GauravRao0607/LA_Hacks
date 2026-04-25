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

const TYPE_BG = {
  Rescue:           'rgba(56,189,248,0.1)',
  Medical:          'rgba(244,63,94,0.1)',
  Evacuation:       'rgba(251,191,36,0.08)',
  Structural:       'rgba(148,163,184,0.08)',
  'Missing Person': 'rgba(249,115,22,0.1)',
  Infrastructure:   'rgba(52,211,153,0.08)',
}

const RESPONDER_LABEL = { fire: 'Fire', ems: 'EMS', police: 'Police', rescue: 'Rescue' }

export default function IncidentDetail({ incident, onClose }) {
  if (!incident) return null

  const tierColor = TIER_COLORS[incident.tier]
  const Icon = TYPE_ICONS[incident.type] || AlertTriangle
  const iconBg = TYPE_BG[incident.type] || 'rgba(255,255,255,0.05)'

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
        <div className="detail-header">
          <div className="detail-header-left">
            <div className="detail-icon" style={{ background: iconBg, color: tierColor }}>
              <Icon size={18} />
            </div>
            <div className="detail-title-block">
              <div className="detail-type">{incident.type}</div>
              <div
                className="detail-tier-badge"
                style={{ background: `${tierColor}18`, color: tierColor, border: `1px solid ${tierColor}44` }}
              >
                <span className="tier-dot-sm" style={{ background: tierColor, boxShadow: `0 0 4px ${tierColor}` }} />
                {incident.tier}
              </div>
            </div>
          </div>
          <button className="close-btn" onClick={onClose}>
            <X size={14} />
          </button>
        </div>

        <div className="detail-body">
          <div className="detail-description" style={{ '--tier': tierColor }}>
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
              <div className="detail-field-label"><MapPin size={11} /> Location</div>
              <div className="detail-field-value">{incident.address}</div>
            </div>

            <div className="detail-field">
              <div className="detail-field-label"><Clock size={11} /> Reported</div>
              <div className="detail-field-value">{incident.timeAgo}</div>
            </div>

            {incident.people != null && incident.people > 0 && (
              <div className="detail-field">
                <div className="detail-field-label"><Users size={11} /> People</div>
                <div className="detail-field-value">{incident.people}</div>
              </div>
            )}

            {incident.call_count > 1 && (
              <div className="detail-field">
                <div className="detail-field-label"><Radio size={11} /> Calls</div>
                <div className="detail-field-value">{incident.call_count} clustered</div>
              </div>
            )}

            <div className="detail-field">
              <div className="detail-field-label"><TrendingUp size={11} /> Priority Score</div>
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
              <div className="detail-field-label"><Hash size={11} /> Report ID</div>
              <div className="detail-field-value mono">RPT-{reportId}</div>
            </div>
          </div>

          {respList.length > 0 && (
            <>
              <div className="detail-divider" />
              <div style={{
                marginBottom: 8,
                fontSize: 11,
                color: 'rgba(255,255,255,0.5)',
                textTransform: 'uppercase',
                letterSpacing: 0.5,
              }}>
                Required Responders
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {respList.map(([k, v]) => (
                  <div key={k} style={{
                    padding: '6px 10px',
                    borderRadius: 6,
                    fontSize: 12,
                    background: 'rgba(255,255,255,0.06)',
                    border: '1px solid rgba(255,255,255,0.1)',
                    color: 'rgba(255,255,255,0.85)',
                  }}>
                    <span style={{ fontWeight: 600 }}>{v}</span> {RESPONDER_LABEL[k] || k}
                  </div>
                ))}
              </div>
            </>
          )}

          <div className="detail-divider" />

          <div className="detail-actions">
            <button className="action-btn dispatch">
              <Radio size={13} />
              Dispatch
            </button>
            <button className="action-btn resolve" onClick={handleResolve}>
              <CheckCircle size={13} />
              Resolve
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
