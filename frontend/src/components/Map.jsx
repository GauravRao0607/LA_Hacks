import { useRef, useEffect } from 'react'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import { TIER_COLORS } from '../data/constants'
import { VEHICLE_CONFIG, BASE_STATIONS } from '../data/vehicles'
import '../styles/Map.css'

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN
const TIER_OPACITY = { Critical: 1.0, Urgent: 0.9, Standard: 0.8 }

const EMPTY_FC = { type: 'FeatureCollection', features: [] }

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

const stationFC = {
  type: 'FeatureCollection',
  features: BASE_STATIONS.map(s => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [s.lng, s.lat] },
    properties: { id: s.id, name: s.name, type: s.type, color: VEHICLE_CONFIG[s.type].color },
  })),
}

export default function ThreatMap({
  incidents = [],
  selectedId,
  onSelectIncident,
  vehicleGeoJSON = EMPTY_FC,
  routeGeoJSON   = EMPTY_FC,
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
      map.addLayer({ id: 'incidents-core', type: 'circle', source: 'incidents', paint: {
        'circle-radius':        ['interpolate', ['linear'], ['zoom'], 2, 3, 6, 7, 12, 12],
        'circle-color':         ['get', 'color'],
        'circle-opacity':       ['get', 'opacity'],
        'circle-stroke-width':  1.5,
        'circle-stroke-color':  '#ffffff',
        'circle-stroke-opacity': 0.6,
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

      // ── Base stations ──────────────────────────────────────────────────────
      map.addSource('stations', { type: 'geojson', data: stationFC })
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
          ['==', ['get', 'type'], 'fire'],   '#f97316',
          ['==', ['get', 'type'], 'ems'],    '#34d399',
          ['==', ['get', 'type'], 'police'], '#60a5fa',
          '#a78bfa',
        ],
        'line-width':   2,
        'line-opacity': 0.55,
        'line-dasharray': [2, 2],
      }})

      // ── Vehicles ───────────────────────────────────────────────────────────
      map.addSource('vehicles', { type: 'geojson', data: EMPTY_FC })
      map.addLayer({ id: 'vehicles-halo', type: 'circle', source: 'vehicles', paint: {
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
        'circle-radius': 6,
        'circle-color':  ['case',
          ['==', ['get', 'type'], 'fire'],   '#f97316',
          ['==', ['get', 'type'], 'ems'],    '#34d399',
          ['==', ['get', 'type'], 'police'], '#60a5fa',
          '#a78bfa',
        ],
        'circle-opacity': 1,
        'circle-stroke-width':  1.5,
        'circle-stroke-color':  '#ffffff',
        'circle-stroke-opacity': 0.9,
      }})

      // ── Interaction ────────────────────────────────────────────────────────
      map.on('click', 'incidents-core', e => {
        const id  = e.features[0].properties.id
        const inc = incidentsRef.current.find(i => i.id === id)
        if (inc) onSelectIncident(inc)
      })
      map.on('mouseenter', 'incidents-core', () => { map.getCanvas().style.cursor = 'pointer' })
      map.on('mouseleave', 'incidents-core', () => { map.getCanvas().style.cursor = '' })
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

  // ── Selected incident highlight ───────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map?.isStyleLoaded()) return
    if (selectedId) {
      map.setPaintProperty('incidents-core', 'circle-stroke-width',
        ['case', ['==', ['get', 'id'], selectedId], 3, 1.5])
      map.setPaintProperty('incidents-core', 'circle-radius', [
        'interpolate', ['linear'], ['zoom'],
        2, ['case', ['==', ['get', 'id'], selectedId], 5, 3],
        6, ['case', ['==', ['get', 'id'], selectedId], 10, 7],
        12, ['case', ['==', ['get', 'id'], selectedId], 16, 12],
      ])
    } else {
      map.setPaintProperty('incidents-core', 'circle-stroke-width', 1.5)
      map.setPaintProperty('incidents-core', 'circle-radius',
        ['interpolate', ['linear'], ['zoom'], 2, 3, 6, 7, 12, 12])
    }
  }, [selectedId])

  // ── Fly to selected incident ──────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map || !selectedId) return
    const inc = incidents.find(i => i.id === selectedId)
    if (!inc?.lat) return
    map.flyTo({ center: [inc.lng, inc.lat], zoom: 14, duration: 1800, essential: true })
  }, [selectedId, incidents])

  return <div ref={containerRef} className="map-container" />
}
