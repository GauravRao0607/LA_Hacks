import { useRef, useState, useCallback, useMemo, useEffect } from 'react'
import { Graph as G6Graph } from '@antv/g6'
import { X, Network } from 'lucide-react'
import { TIER_COLORS } from '../data/constants'
import '../styles/KnowledgeGraph.css'

const LINK_TYPES = {
  resource_conflict:    { color: '#f43f5e', label: 'Resource Conflict',    desc: 'Competing for the same responder type' },
  dispatch_opportunity: { color: '#34d399', label: 'Dispatch Opportunity', desc: 'Within 2 km — one unit can cover both' },
  event_cluster:        { color: '#818cf8', label: 'Event Cluster',        desc: 'Same incident type — possible common cause' },
}

const TIERS   = ['Critical', 'Urgent', 'Standard']
const COL_X   = { Critical: 200, Urgent: 550, Standard: 900 }
const ROW_GAP = 110
const ROW_TOP = 100

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function sharedResponders(a, b) {
  const ar = Object.entries(a.required_responders || {}).filter(([, v]) => v > 0).map(([k]) => k)
  const br = Object.entries(b.required_responders || {}).filter(([, v]) => v > 0).map(([k]) => k)
  return ar.filter(k => br.includes(k))
}

function buildGraphData(incidents) {
  const byTier = { Critical: [], Urgent: [], Standard: [] }
  incidents.forEach(inc => { (byTier[inc.tier] ?? byTier.Standard).push(inc) })
  TIERS.forEach(t => byTier[t].sort((a, b) => b.score - a.score))

  const nodes = []
  TIERS.forEach(tier => {
    byTier[tier].forEach((inc, i) => {
      nodes.push({
        id:    String(inc.id),
        x:     COL_X[tier],
        y:     ROW_TOP + i * ROW_GAP,
        label: inc.type,
        data:  { incident: inc, tier: inc.tier, score: inc.score },
      })
    })
  })

  const seen     = new Map()
  const PRIORITY = { resource_conflict: 0, dispatch_opportunity: 1, event_cluster: 2 }

  const propose = (a, b, type, meta) => {
    const key  = [a.id, b.id].sort().join('—')
    const prev = seen.get(key)
    if (!prev || PRIORITY[type] < PRIORITY[prev.edgeType]) {
      seen.set(key, { source: String(a.id), target: String(b.id), edgeType: type, ...meta })
    }
  }

  for (let i = 0; i < incidents.length; i++) {
    for (let j = i + 1; j < incidents.length; j++) {
      const a = incidents[i], b = incidents[j]
      const shared   = sharedResponders(a, b)
      const bothHigh = ['Critical', 'Urgent'].includes(a.tier) && ['Critical', 'Urgent'].includes(b.tier)
      if (shared.length && bothHigh) propose(a, b, 'resource_conflict', { shared })
      if (a.lat != null && b.lat != null) {
        const dist = haversineKm(a.lat, a.lng, b.lat, b.lng)
        if (dist < 2) propose(a, b, 'dispatch_opportunity', { dist: dist.toFixed(1) })
      }
      if (a.type === b.type) propose(a, b, 'event_cluster', {})
    }
  }

  const edges = [...seen.values()].map((e, i) => ({
    id:     `e${i}`,
    source: e.source,
    target: e.target,
    data:   e,
  }))

  return { nodes, edges }
}

export default function KnowledgeGraph({ incidents = [], onClose, onSelectIncident }) {
  const containerRef = useRef(null)
  const graphRef     = useRef(null)
  const [filter, setFilter]           = useState('All')
  const [activeTypes, setActiveTypes] = useState(new Set(Object.keys(LINK_TYPES)))
  const [tooltip, setTooltip]         = useState(null)   // { kind, data, x, y }
  const [mousePos, setMousePos]       = useState({ x: 0, y: 0 })

  const visible = useMemo(() =>
    filter === 'All' ? incidents : incidents.filter(i => i.tier === filter),
    [incidents, filter]
  )

  const { nodes, edges: allEdges } = useMemo(() => buildGraphData(visible), [visible])
  const edges = useMemo(
    () => allEdges.filter(e => activeTypes.has(e.data?.edgeType)),
    [allEdges, activeTypes]
  )

  const counts = useMemo(() => ({
    Critical: incidents.filter(i => i.tier === 'Critical').length,
    Urgent:   incidents.filter(i => i.tier === 'Urgent').length,
    Standard: incidents.filter(i => i.tier === 'Standard').length,
  }), [incidents])

  const linkCounts = useMemo(() => {
    const { edges: ae } = buildGraphData(incidents)
    return Object.fromEntries(
      Object.keys(LINK_TYPES).map(t => [t, ae.filter(e => e.data?.edgeType === t).length])
    )
  }, [incidents])

  // Build + mount G6 graph
  useEffect(() => {
    if (!containerRef.current || nodes.length === 0) return

    const w = containerRef.current.clientWidth
    const h = containerRef.current.clientHeight

    const graph = new G6Graph({
      container: containerRef.current,
      width:  w,
      height: h,
      theme:  'dark',
      background: '#000000',
      layout: { type: 'preset' },
      node: {
        style: {
          x:      d => d.x,
          y:      d => d.y,
          r:      d => 8 + ((d.data?.score || 50) / 100) * 8,
          fill:   d => TIER_COLORS[d.data?.tier] + 'cc',
          stroke: d => TIER_COLORS[d.data?.tier],
          lineWidth:   1.5,
          shadowColor: d => TIER_COLORS[d.data?.tier],
          shadowBlur:  d => d.data?.tier === 'Critical' ? 18 : 8,
          labelText:       d => d.label || '',
          labelFontSize:   11,
          labelFontFamily: 'Inter, system-ui',
          labelFontWeight: 500,
          labelFill:       '#4b5563',
          labelPlacement:  'bottom',
          labelOffsetY:    4,
        },
        state: {
          active: {
            fill:        d => TIER_COLORS[d.data?.tier],
            shadowBlur:  24,
            lineWidth:   2,
            labelFill:   '#e5e7eb',
          },
          inactive: {
            fill:       '#111827',
            stroke:     '#1f2937',
            shadowBlur: 0,
            labelFill:  '#1f2937',
          },
        },
      },
      edge: {
        style: {
          stroke:    d => LINK_TYPES[d.data?.edgeType]?.color || '#374151',
          lineWidth: d => d.data?.edgeType === 'resource_conflict' ? 2 : 1,
          opacity:   0.55,
          lineDash:  d => d.data?.edgeType === 'event_cluster' ? [4, 6] : undefined,
        },
        state: {
          active:   { opacity: 0.9, lineWidth: 2 },
          inactive: { opacity: 0.04 },
        },
      },
      behaviors: [
        'zoom-canvas',
        'drag-canvas',
        { type: 'hover-activate', degree: 1, inactiveState: 'inactive', activeState: 'active' },
      ],
    })

    graph.setData({ nodes, edges })
    graph.render().then(() => {
      graph.fitView({ padding: 60 })
    })

    graph.on('node:click', evt => {
      const d = evt.target?.attributes?.data || graph.getNodeData(evt.target?.id)?.data
      const inc = d?.incident
      if (inc) { onSelectIncident(inc); onClose() }
    })

    graph.on('node:pointerenter', evt => {
      const id  = evt.target?.id
      const raw = graph.getNodeData(id)
      if (raw?.data?.incident) {
        const rect = containerRef.current.getBoundingClientRect()
        setTooltip({
          kind: 'node',
          data: raw.data,
          x:    evt.client.x - rect.left,
          y:    evt.client.y - rect.top,
        })
      }
    })

    graph.on('node:pointermove', evt => {
      const rect = containerRef.current?.getBoundingClientRect()
      if (rect) setMousePos({ x: evt.client.x - rect.left, y: evt.client.y - rect.top })
    })

    graph.on('node:pointerleave', () => setTooltip(null))

    graph.on('edge:pointerenter', evt => {
      const id  = evt.target?.id
      const raw = graph.getEdgeData(id)
      if (raw?.data) {
        const rect = containerRef.current?.getBoundingClientRect()
        setTooltip({
          kind: 'edge',
          data: raw.data,
          x:    evt.client.x - rect.left,
          y:    evt.client.y - rect.top,
        })
      }
    })

    graph.on('edge:pointermove', evt => {
      const rect = containerRef.current?.getBoundingClientRect()
      if (rect) setMousePos({ x: evt.client.x - rect.left, y: evt.client.y - rect.top })
    })

    graph.on('edge:pointerleave', () => setTooltip(null))

    graphRef.current = graph
    return () => { graph.destroy(); graphRef.current = null }
  }, [nodes, edges, onSelectIncident, onClose])

  const toggleLinkType = useCallback(type => {
    setActiveTypes(prev => {
      const next = new Set(prev)
      next.has(type) ? next.delete(type) : next.add(type)
      return next
    })
  }, [])

  const tt = tooltip

  return (
    <div className="graph-overlay">
      {/* ── Left panel ── */}
      <div className="graph-panel">
        <div className="graph-panel-title">
          <Network size={12} />
          Incident Graph
        </div>

        <div className="graph-panel-section">
          <div className="graph-panel-label">Severity</div>
          {TIERS.map(tier => (
            <div key={tier} className="graph-stat-row">
              <div className="graph-stat-dot" style={{ background: TIER_COLORS[tier] }} />
              <span className="graph-stat-name">{tier}</span>
              <span className="graph-stat-val">{counts[tier]}</span>
            </div>
          ))}
        </div>

        <div className="graph-panel-section">
          <div className="graph-panel-label">Filter tier</div>
          {['All', ...TIERS].map(f => (
            <button
              key={f}
              className={`graph-filter-btn ${filter === f ? 'active' : ''}`}
              style={filter === f && f !== 'All'
                ? { borderColor: TIER_COLORS[f] + '60', color: TIER_COLORS[f] }
                : {}}
              onClick={() => setFilter(f)}
            >
              {f}
            </button>
          ))}
        </div>

        <div className="graph-panel-section">
          <div className="graph-panel-label">Connections</div>
          {Object.entries(LINK_TYPES).map(([type, cfg]) => (
            <button
              key={type}
              className={`graph-link-toggle ${activeTypes.has(type) ? 'active' : ''}`}
              onClick={() => toggleLinkType(type)}
              title={cfg.desc}
            >
              <span className="gli-swatch" style={{
                background:  activeTypes.has(type) ? cfg.color : 'transparent',
                borderColor: cfg.color + '60',
              }} />
              <span className="gli-label">{cfg.label}</span>
              <span className="gli-count">{linkCounts[type] || 0}</span>
            </button>
          ))}
        </div>

        {tt?.kind === 'edge' && (() => {
          const cfg = LINK_TYPES[tt.data.edgeType]
          if (!cfg) return null
          return (
            <div className="graph-panel-section graph-edge-info">
              <div className="graph-panel-label">Connection</div>
              <div className="gei-type" style={{ color: cfg.color }}>{cfg.label}</div>
              <div className="gei-desc">{cfg.desc}</div>
              {tt.data.edgeType === 'dispatch_opportunity' && tt.data.dist && (
                <div className="gei-meta">{tt.data.dist} km apart</div>
              )}
              {tt.data.edgeType === 'resource_conflict' && tt.data.shared?.length > 0 && (
                <div className="gei-meta">Shared: <strong>{tt.data.shared.join(', ')}</strong></div>
              )}
            </div>
          )
        })()}

        <div className="graph-panel-hint">
          Hover edges to inspect connections. Click a node to open the incident.
        </div>
      </div>

      {/* ── Graph canvas ── */}
      <div className="graph-canvas-wrap">
        {incidents.length === 0 ? (
          <div className="graph-empty">
            <Network size={36} style={{ opacity: 0.15 }} />
            <span className="graph-empty-text">No incidents to visualize</span>
          </div>
        ) : (
          <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
        )}

        {/* Node tooltip */}
        {tt?.kind === 'node' && (
          <div className="graph-tooltip" style={{
            left: mousePos.x + 16,
            top:  Math.max(8, mousePos.y - 100),
          }}>
            <div className="tt-type">{tt.data.incident?.type}</div>
            <div className="tt-tier" style={{ color: TIER_COLORS[tt.data.tier] }}>
              {tt.data.tier} · score {tt.data.score}
            </div>
            <div className="tt-divider" />
            <div className="tt-row"><span>Location</span><span>{tt.data.incident?.address}</span></div>
            <div className="tt-row"><span>Reported</span><span>{tt.data.incident?.timeAgo}</span></div>
            {tt.data.incident?.people > 0 && (
              <div className="tt-row"><span>People</span><span>{tt.data.incident.people}</span></div>
            )}
            <div className="tt-hint">Click to open incident</div>
          </div>
        )}
      </div>

      <button className="graph-close-btn" onClick={onClose}>
        <X size={12} />
      </button>
    </div>
  )
}
