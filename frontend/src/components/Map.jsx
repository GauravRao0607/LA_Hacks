import { useRef, useEffect } from 'react'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import { TIER_COLORS } from '../data/mockIncidents'
import '../styles/Map.css'

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN

const TIER_OPACITY = { Critical: 1.0, Urgent: 0.9, Standard: 0.8 }

function toFeatureCollection(incidents) {
  return {
    type: 'FeatureCollection',
    features: incidents
      .filter(inc => inc.lat != null && inc.lng != null)
      .map(inc => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [inc.lng, inc.lat] },
        properties: {
          id: inc.id,
          tier: inc.tier,
          color: TIER_COLORS[inc.tier],
          opacity: TIER_OPACITY[inc.tier],
        },
      })),
  }
}

export default function ThreatMap({ incidents = [], selectedId, onSelectIncident }) {
  const containerRef = useRef()
  const mapRef = useRef()
  const incidentsRef = useRef(incidents)
  incidentsRef.current = incidents

  // One-time map setup
  useEffect(() => {
    mapboxgl.accessToken = MAPBOX_TOKEN

    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: 'mapbox://styles/mapbox/satellite-streets-v12',
      center: [-118.32, 34.07], // LA
      zoom: 10,
      projection: 'globe',
      antialias: true,
    })

    mapRef.current = map
    map.addControl(new mapboxgl.NavigationControl(), 'bottom-right')

    map.on('style.load', () => {
      map.setFog({
        color: 'rgb(8, 12, 30)',
        'high-color': 'rgb(20, 40, 100)',
        'horizon-blend': 0.04,
        'space-color': 'rgb(2, 4, 18)',
        'star-intensity': 0.85,
      })

      map.addSource('incidents', {
        type: 'geojson',
        data: toFeatureCollection(incidentsRef.current),
      })

      map.addLayer({
        id: 'incidents-halo',
        type: 'circle',
        source: 'incidents',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 2, 8, 6, 18, 12, 28],
          'circle-color': ['get', 'color'],
          'circle-opacity': 0.15,
          'circle-blur': 1,
        },
      })

      map.addLayer({
        id: 'incidents-glow',
        type: 'circle',
        source: 'incidents',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 2, 5, 6, 12, 12, 20],
          'circle-color': ['get', 'color'],
          'circle-opacity': 0.3,
          'circle-blur': 0.5,
        },
      })

      map.addLayer({
        id: 'incidents-core',
        type: 'circle',
        source: 'incidents',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 2, 3, 6, 7, 12, 12],
          'circle-color': ['get', 'color'],
          'circle-opacity': ['get', 'opacity'],
          'circle-stroke-width': 1.5,
          'circle-stroke-color': '#ffffff',
          'circle-stroke-opacity': 0.6,
        },
      })

      map.addLayer({
        id: 'incidents-pulse',
        type: 'circle',
        source: 'incidents',
        filter: ['==', ['get', 'tier'], 'Critical'],
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 2, 10, 6, 22, 12, 36],
          'circle-color': ['get', 'color'],
          'circle-opacity': 0.12,
          'circle-blur': 0.8,
          'circle-stroke-width': 1,
          'circle-stroke-color': ['get', 'color'],
          'circle-stroke-opacity': 0.5,
        },
      })

      map.on('click', 'incidents-core', (e) => {
        const id = e.features[0].properties.id
        const incident = incidentsRef.current.find(i => i.id === id)
        if (incident) onSelectIncident(incident)
      })
      map.on('mouseenter', 'incidents-core', () => {
        map.getCanvas().style.cursor = 'pointer'
      })
      map.on('mouseleave', 'incidents-core', () => {
        map.getCanvas().style.cursor = ''
      })
    })

    const onResize = () => map.resize()
    window.addEventListener('resize', onResize)

    return () => {
      window.removeEventListener('resize', onResize)
      map.remove()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Push live incidents into the GeoJSON source whenever they change
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const apply = () => {
      const source = map.getSource('incidents')
      if (source) source.setData(toFeatureCollection(incidents))
    }
    if (map.isStyleLoaded()) apply()
    else map.once('style.load', apply)
  }, [incidents])

  // Highlight selected incident
  useEffect(() => {
    const map = mapRef.current
    if (!map || !map.isStyleLoaded()) return

    if (selectedId) {
      map.setPaintProperty('incidents-core', 'circle-stroke-width', [
        'case', ['==', ['get', 'id'], selectedId], 3, 1.5,
      ])
      map.setPaintProperty('incidents-core', 'circle-radius', [
        'interpolate', ['linear'], ['zoom'],
        2, ['case', ['==', ['get', 'id'], selectedId], 5, 3],
        6, ['case', ['==', ['get', 'id'], selectedId], 10, 7],
        12, ['case', ['==', ['get', 'id'], selectedId], 16, 12],
      ])
    } else {
      map.setPaintProperty('incidents-core', 'circle-stroke-width', 1.5)
      map.setPaintProperty('incidents-core', 'circle-radius', [
        'interpolate', ['linear'], ['zoom'], 2, 3, 6, 7, 12, 12,
      ])
    }
  }, [selectedId])

  // Fly to selected incident
  useEffect(() => {
    const map = mapRef.current
    if (!map || !selectedId) return
    const incident = incidents.find(i => i.id === selectedId)
    if (!incident || incident.lat == null) return
    map.flyTo({
      center: [incident.lng, incident.lat],
      zoom: 14,
      duration: 1800,
      essential: true,
    })
  }, [selectedId, incidents])

  return <div ref={containerRef} className="map-container" />
}
