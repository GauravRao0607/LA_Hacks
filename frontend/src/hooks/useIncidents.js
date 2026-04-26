import { useState, useEffect, useRef } from 'react'
import { EventSourcePolyfill } from 'event-source-polyfill'
import { MOCK_INCIDENTS } from '../data/mockIncidents'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000'

// ngrok free tier shows a browser-warning interstitial on first visit.
// This header tells ngrok to skip it for our requests.
export const API_HEADERS = { 'ngrok-skip-browser-warning': 'true' }

const TYPE_RULES = [
  { match: ['gas leak', 'gas-leak'],         hazard: true,  type: 'Infrastructure' },
  { match: ['cardiac', 'medical', 'stab', 'shoot', 'minor injury'], type: 'Medical' },
  { match: ['structural collapse'],          type: 'Structural' },
  { match: ['fire', 'flood'],                type: 'Rescue' },
  { match: ['missing'],                      type: 'Missing Person' },
  { match: ['evacuation'],                   type: 'Evacuation' },
  { match: ['car accident', 'crash'],        type: 'Medical' },
]

function mapType(emergency_type, hazardsBlob) {
  const e = (emergency_type || '').toLowerCase()
  const h = (hazardsBlob || '').toLowerCase()
  for (const r of TYPE_RULES) {
    if (r.hazard && r.match.some(k => h.includes(k))) return r.type
    if (!r.hazard && r.match.some(k => e.includes(k))) return r.type
  }
  return 'Rescue'
}

function timeAgo(iso) {
  if (!iso) return ''
  // Backend stores UTC but emits naive ISO strings ("2026-04-26T01:30:45.123456").
  // JS parses naive strings as local time → for non-UTC timezones the parsed
  // value lands in the future and Date.now() - it is negative, which we'd
  // clamp to 0 ("0s ago" forever). Append 'Z' so it's parsed as UTC.
  const utc = /[zZ]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : iso + 'Z'
  const ms = Date.now() - new Date(utc).getTime()
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  return `${h}h ago`
}

function buildDescription(inc) {
  const last = inc.calls?.length ? inc.calls[inc.calls.length - 1] : null
  if (!last) return inc.primary_emergency_type
  const parts = []
  parts.push(`${last.emergency_type}.`)
  if (last.num_people && last.num_people > 1) parts.push(`${last.num_people} people involved.`)
  if (last.injuries && last.injuries !== 'none') parts.push(`Injuries: ${last.injuries}.`)
  if (last.hazards && last.hazards !== 'none') parts.push(`Hazards: ${last.hazards}.`)
  if (last.mobility && last.mobility !== 'mobile') parts.push(`Mobility: ${last.mobility}.`)
  if (inc.call_count > 1) parts.push(`${inc.call_count} clustered calls.`)
  return parts.join(' ')
}

function adapt(inc) {
  const totalPeople = (inc.calls || []).reduce((s, c) => s + (c.num_people || 0), 0)
  const hazardsBlob = (inc.calls || []).map(c => c.hazards || '').join(' ')
  const topCall = [...(inc.calls || [])].sort((a, b) => (b.call_score || 0) - (a.call_score || 0))[0]
  return {
    ...inc,
    type:        mapType(inc.primary_emergency_type, hazardsBlob),
    address:     inc.location_label,
    description: buildDescription(inc),
    timeAgo:     timeAgo(inc.created_at),
    people:      totalPeople || null,
    lat:         inc.centroid_lat,
    lng:         inc.centroid_lng,
    situation:   topCall?.situation || '',
  }
}

export function useIncidents() {
  const [incidents, setIncidents] = useState([])
  const gotRealData = useRef(false)

  useEffect(() => {
    let es
    let cancelled = false

    // Fall back to mock data after 3s if stream hasn't delivered anything
    const fallbackTimer = setTimeout(() => {
      if (!cancelled && !gotRealData.current) {
        setIncidents(MOCK_INCIDENTS)
      }
    }, 3000)

    const start = () => {
      es = new EventSourcePolyfill(`${API_URL}/incidents/stream`, {
        headers: API_HEADERS,
        heartbeatTimeout: 60_000,
      })
      es.onmessage = (e) => {
        if (cancelled) return
        try {
          const data = JSON.parse(e.data)
          if (data.length > 0) {
            gotRealData.current = true
            clearTimeout(fallbackTimer)
            setIncidents(data.map(adapt))
          }
        } catch (err) {
          console.error('SSE parse error', err)
        }
      }
      es.onerror = () => {
        console.warn('[useIncidents] SSE error; browser will reconnect')
      }
    }

    start()
    return () => {
      cancelled = true
      clearTimeout(fallbackTimer)
      if (es) es.close()
    }
  }, [])

  return incidents
}

export { API_URL }
