import { useRef, useEffect } from 'react'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import { TIER_COLORS } from '../data/constants'
import { VEHICLE_CONFIG } from '../data/vehicles'
import '../styles/Map.css'

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN
const TIER_OPACITY = { Critical: 1.0, Urgent: 0.9, Standard: 0.8 }

const EMPTY_FC = { type: 'FeatureCollection', features: [] }

const VEHICLE_COLORS = { fire: '#ef4444', ems: '#f1f5f9', police: '#2563eb' }

function makeCarImage(bodyColor) {
  const W = 20, H = 32
  const canvas = document.createElement('canvas')
  canvas.width = W; canvas.height = H
  const ctx = canvas.getContext('2d')
  const rr = (x, y, w, h, r) => {
    ctx.beginPath()
    ctx.moveTo(x + r, y)
    ctx.arcTo(x + w, y,     x + w, y + h, r)
    ctx.arcTo(x + w, y + h, x,     y + h, r)
    ctx.arcTo(x,     y + h, x,     y,     r)
    ctx.arcTo(x,     y,     x + w, y,     r)
    ctx.closePath()
  }
  // Body
  rr(2, 1, W - 4, H - 2, 4)
  ctx.fillStyle = bodyColor; ctx.fill()
  ctx.strokeStyle = 'rgba(0,0,0,0.28)'; ctx.lineWidth = 0.8; ctx.stroke()
  // Windshields
  rr(4, 5, W - 8, 7, 2)
  ctx.fillStyle = 'rgba(147,197,253,0.78)'; ctx.fill()
  rr(4, H - 12, W - 8, 6, 2)
  ctx.fillStyle = 'rgba(147,197,253,0.55)'; ctx.fill()
  // Wheels
  ctx.fillStyle = '#18181b'
  ;[[0, 5], [W - 3, 5], [0, H - 10], [W - 3, H - 10]].forEach(([x, y]) => { rr(x, y, 3, 6, 1); ctx.fill() })
  return { width: W, height: H, data: new Uint8Array(ctx.getImageData(0, 0, W, H).data.buffer) }
}

function makePinImage(color) {
  const W = 28, H = 38
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')
  const cx = W / 2, r = 12, cy = r + 2
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.fillStyle = color; ctx.fill()
  ctx.beginPath()
  ctx.moveTo(cx - 6, cy + 8); ctx.lineTo(cx, H - 2); ctx.lineTo(cx + 6, cy + 8)
  ctx.fillStyle = color; ctx.fill()
  ctx.beginPath(); ctx.arc(cx, cy, 4.5, 0, Math.PI * 2)
  ctx.fillStyle = 'rgba(255,255,255,0.88)'; ctx.fill()
  return { width: W, height: H, data: new Uint8Array(ctx.getImageData(0, 0, W, H).data.buffer) }
}

function toIncidentFC(incidents) {
  return {
    type: 'FeatureCollection',
    features: incidents
      .filter(inc => inc.lat != null && inc.lng != null)
      .map(inc => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [inc.lng, inc.lat] },
        properties: {
          id:      inc.id,
          tier:    inc.tier,
          color:   TIER_COLORS[inc.tier],
          opacity: TIER_OPACITY[inc.tier],
        },
      })),
  }
}

// Dispatched-station GeoJSON now comes from useDispatch live; we colour each
// station marker by responder type via the same VEHICLE_CONFIG palette.
function colourStationFC(fc) {
  if (!fc?.features) return EMPTY_FC
  return {
    type: 'FeatureCollection',
    features: fc.features.map(f => ({
      ...f,
      properties: {
        ...f.properties,
        color: VEHICLE_CONFIG[f.properties.type]?.color || '#888',
      },
    })),
  }
}

export default function ThreatMap({
  incidents = [],
  selectedId,
  onSelectIncident,
  vehicleGeoJSON = EMPTY_FC,
  routeGeoJSON   = EMPTY_FC,
  stationGeoJSON = EMPTY_FC,
}) {
  const containerRef  = useRef()
  const mapRef        = useRef()
  const incidentsRef  = useRef(incidents)
  incidentsRef.current = incidents

  // ── One-time map setup ────────────────────────────────────────────────────
  useEffect(() => {
    mapboxgl.accessToken = MAPBOX_TOKEN

    const map = new mapboxgl.Map({
      container:  containerRef.current,
      style:      'mapbox://styles/mapbox/satellite-streets-v12',
      center:     [-95.37, 29.76],
      zoom:       10,
      projection: 'globe',
      antialias:  true,
    })

    mapRef.current = map
    map.addControl(new mapboxgl.NavigationControl(), 'bottom-right')

    map.on('style.load', () => {
      map.setFog({
        color:           'rgb(8, 12, 30)',
        'high-color':    'rgb(20, 40, 100)',
        'horizon-blend': 0.04,
        'space-color':   'rgb(2, 4, 18)',
        'star-intensity': 0.85,
      })

      Object.entries(TIER_COLORS).forEach(([tier, color]) => {
        map.addImage(`pin-${tier}`, makePinImage(color))
      })
      Object.entries(VEHICLE_COLORS).forEach(([type, color]) => {
        map.addImage(`car-${type}`, makeCarImage(color))
      })

      // ── Incidents ──────────────────────────────────────────────────────────
      map.addSource('incidents', { type: 'geojson', data: toIncidentFC(incidentsRef.current) })
      map.addLayer({ id: 'incidents-halo', type: 'circle', source: 'incidents', paint: {
        'circle-radius':  ['interpolate', ['linear'], ['zoom'], 2, 8, 6, 18, 12, 28],
        'circle-color':   ['get', 'color'],
        'circle-opacity': 0.15, 'circle-blur': 1,
      }})
      map.addLayer({ id: 'incidents-glow', type: 'circle', source: 'incidents', paint: {
        'circle-radius':  ['interpolate', ['linear'], ['zoom'], 2, 5, 6, 12, 12, 20],
        'circle-color':   ['get', 'color'],
        'circle-opacity': 0.3, 'circle-blur': 0.5,
      }})
      map.addLayer({ id: 'incidents-pins', type: 'symbol', source: 'incidents', layout: {
        'icon-image':         ['concat', 'pin-', ['get', 'tier']],
        'icon-size':          ['interpolate', ['linear'], ['zoom'], 4, 0.7, 8, 1.0, 12, 1.3],
        'icon-allow-overlap': true,
        'icon-anchor':        'bottom',
      }})
      map.addLayer({ id: 'incidents-pulse', type: 'circle', source: 'incidents',
        filter: ['==', ['get', 'tier'], 'Critical'],
        paint: {
          'circle-radius':         ['interpolate', ['linear'], ['zoom'], 2, 10, 6, 22, 12, 36],
          'circle-color':          ['get', 'color'],
          'circle-opacity':        0.12, 'circle-blur': 0.8,
          'circle-stroke-width':   1,
          'circle-stroke-color':   ['get', 'color'],
          'circle-stroke-opacity': 0.5,
        },
      })

      // ── Dispatched stations (live) ─────────────────────────────────────────
      map.addSource('stations', { type: 'geojson', data: colourStationFC(stationGeoJSON) })
      map.addLayer({ id: 'stations-ring', type: 'circle', source: 'stations', paint: {
        'circle-radius':  6,
        'circle-color':   ['get', 'color'],
        'circle-opacity': 0.15,
        'circle-stroke-width': 1,
        'circle-stroke-color': ['get', 'color'],
        'circle-stroke-opacity': 0.5,
      }})

      // ── Dispatch routes ────────────────────────────────────────────────────
      map.addSource('routes', { type: 'geojson', data: EMPTY_FC })
      map.addLayer({ id: 'routes-line', type: 'line', source: 'routes', paint: {
        'line-color':   ['case',
          ['==', ['get', 'type'], 'fire'],   '#ef4444',
          ['==', ['get', 'type'], 'ems'],    '#f1f5f9',
          ['==', ['get', 'type'], 'police'], '#2563eb',
          '#888888',
        ],
        'line-width':   2,
        'line-opacity': 0.55,
        'line-dasharray': [2, 2],
      }})

      // ── Vehicles ───────────────────────────────────────────────────────────
      map.addSource('vehicles', { type: 'geojson', data: EMPTY_FC })
      map.addLayer({ id: 'vehicles-halo', type: 'circle', source: 'vehicles',
        filter: ['!=', ['get', 'status'], 'available'],
        paint: {
          'circle-radius': 14,
          'circle-color':  ['case',
            ['==', ['get', 'type'], 'fire'],   '#f97316',
            ['==', ['get', 'type'], 'ems'],    '#34d399',
            ['==', ['get', 'type'], 'police'], '#60a5fa',
            '#a78bfa',
          ],
          'circle-opacity': 0.18,
          'circle-blur':    1,
        }})
      map.addLayer({ id: 'vehicles-dot', type: 'circle', source: 'vehicles', paint: {
        'circle-radius': ['case', ['==', ['get', 'status'], 'available'], 4, 6],
        'circle-color':  ['case',
          ['==', ['get', 'type'], 'fire'],   '#ef4444',
          ['==', ['get', 'type'], 'ems'],    '#f1f5f9',
          ['==', ['get', 'type'], 'police'], '#2563eb',
          '#888888',
        ],
        'circle-opacity': ['case', ['==', ['get', 'status'], 'available'], 0.4, 1],
        'circle-stroke-width':  1.5,
        'circle-stroke-color':  '#ffffff',
        'circle-stroke-opacity': ['case', ['==', ['get', 'status'], 'available'], 0.3, 0.9],
      }})

      // ── Interaction ────────────────────────────────────────────────────────
      map.on('click', 'incidents-pins', e => {
        const id  = e.features[0].properties.id
        const inc = incidentsRef.current.find(i => i.id === id)
        if (inc) onSelectIncident(inc)
      })
      map.on('mouseenter', 'incidents-pins', () => { map.getCanvas().style.cursor = 'pointer' })
      map.on('mouseleave', 'incidents-pins', () => { map.getCanvas().style.cursor = '' })
    })

    const onResize = () => map.resize()
    window.addEventListener('resize', onResize)
    return () => { window.removeEventListener('resize', onResize); map.remove() }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Live incident update ──────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const apply = () => {
      map.getSource('incidents')?.setData(toIncidentFC(incidents))
    }
    if (map.isStyleLoaded()) apply(); else map.once('style.load', apply)
  }, [incidents])

  // ── Vehicle positions (called every animation frame from parent) ──────────
  useEffect(() => {
    const map = mapRef.current
    if (!map?.isStyleLoaded()) return
    map.getSource('vehicles')?.setData(vehicleGeoJSON)
  }, [vehicleGeoJSON])

  // ── Route lines ───────────────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map?.isStyleLoaded()) return
    map.getSource('routes')?.setData(routeGeoJSON)
  }, [routeGeoJSON])

  // ── Live dispatched stations ──────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map?.isStyleLoaded()) return
    map.getSource('stations')?.setData(colourStationFC(stationGeoJSON))
  }, [stationGeoJSON])

  // ── Selected incident highlight ───────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map?.isStyleLoaded()) return
    if (selectedId) {
      map.setLayoutProperty('incidents-pins', 'icon-size', [
        'interpolate', ['linear'], ['zoom'],
        4,  ['case', ['==', ['get', 'id'], selectedId], 1.0, 0.7],
        8,  ['case', ['==', ['get', 'id'], selectedId], 1.35, 1.0],
        12, ['case', ['==', ['get', 'id'], selectedId], 1.7, 1.3],
      ])
    } else {
      map.setLayoutProperty('incidents-pins', 'icon-size',
        ['interpolate', ['linear'], ['zoom'], 4, 0.7, 8, 1.0, 12, 1.3])
    }
  }, [selectedId])

  // ── Fly to selected incident (only on selection change, not data updates) ──
  useEffect(() => {
    const map = mapRef.current
    if (!map || !selectedId) return
    const inc = incidentsRef.current.find(i => i.id === selectedId)
    if (!inc?.lat) return
    map.flyTo({ center: [inc.lng, inc.lat], zoom: 14, duration: 1800, essential: true })
  }, [selectedId])

  return <div ref={containerRef} className="map-container" />
}
