import { useRef, useEffect } from 'react'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import { MOCK_INCIDENTS, TIER_COLORS } from '../data/mockIncidents'
import '../styles/Map.css'

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN

const TIER_OPACITY = { Critical: 1.0, Urgent: 0.9, Standard: 0.8 }

export default function ThreatMap({ selectedId, onSelectIncident }) {
  const containerRef = useRef()
  const mapRef = useRef()
  const markersRef = useRef([])

  useEffect(() => {
    mapboxgl.accessToken = MAPBOX_TOKEN

    const map = new mapboxgl.Map({
      container: containerRef.current,
      // Satellite + streets for Google Maps quality when zoomed in
      style: 'mapbox://styles/mapbox/satellite-streets-v12',
      center: [-95.37, 29.76],
      zoom: 11,
      projection: 'globe',     // <-- seamless globe → street transition
      antialias: true,
    })

    mapRef.current = map

    map.addControl(new mapboxgl.NavigationControl(), 'bottom-right')

    map.on('style.load', () => {
      // Globe atmosphere & star field
      map.setFog({
        color: 'rgb(8, 12, 30)',
        'high-color': 'rgb(20, 40, 100)',
        'horizon-blend': 0.04,
        'space-color': 'rgb(2, 4, 18)',
        'star-intensity': 0.85,
      })

      // Incident source
      map.addSource('incidents', {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: MOCK_INCIDENTS.map(inc => ({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [inc.lng, inc.lat] },
            properties: {
              id: inc.id,
              tier: inc.tier,
              type: inc.type,
              description: inc.description,
              address: inc.address,
              score: inc.score,
              timeAgo: inc.timeAgo,
              color: TIER_COLORS[inc.tier],
              opacity: TIER_OPACITY[inc.tier],
            },
          })),
        },
      })

      // Outer glow halo
      map.addLayer({
        id: 'incidents-halo',
        type: 'circle',
        source: 'incidents',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'],
            2, 8, 6, 18, 12, 28
          ],
          'circle-color': ['get', 'color'],
          'circle-opacity': 0.15,
          'circle-blur': 1,
        },
      })

      // Mid glow ring
      map.addLayer({
        id: 'incidents-glow',
        type: 'circle',
        source: 'incidents',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'],
            2, 5, 6, 12, 12, 20
          ],
          'circle-color': ['get', 'color'],
          'circle-opacity': 0.3,
          'circle-blur': 0.5,
        },
      })

      // Core dot
      map.addLayer({
        id: 'incidents-core',
        type: 'circle',
        source: 'incidents',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'],
            2, 3, 6, 7, 12, 12
          ],
          'circle-color': ['get', 'color'],
          'circle-opacity': ['get', 'opacity'],
          'circle-stroke-width': 1.5,
          'circle-stroke-color': '#ffffff',
          'circle-stroke-opacity': 0.6,
        },
      })

      // Pulse ring for Critical — animated via CSS
      map.addLayer({
        id: 'incidents-pulse',
        type: 'circle',
        source: 'incidents',
        filter: ['==', ['get', 'tier'], 'Critical'],
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'],
            2, 10, 6, 22, 12, 36
          ],
          'circle-color': ['get', 'color'],
          'circle-opacity': 0.12,
          'circle-blur': 0.8,
          'circle-stroke-width': 1,
          'circle-stroke-color': ['get', 'color'],
          'circle-stroke-opacity': 0.5,
        },
      })

      // Click handler
      map.on('click', 'incidents-core', (e) => {
        const props = e.features[0].properties
        const incident = MOCK_INCIDENTS.find(i => i.id === props.id)
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

  // Highlight selected incident
  useEffect(() => {
    const map = mapRef.current
    if (!map || !map.isStyleLoaded()) return

    if (selectedId) {
      map.setPaintProperty('incidents-core', 'circle-stroke-width', [
        'case', ['==', ['get', 'id'], selectedId], 3, 1.5
      ])
      map.setPaintProperty('incidents-core', 'circle-radius', [
        'interpolate', ['linear'], ['zoom'],
        2, ['case', ['==', ['get', 'id'], selectedId], 5, 3],
        6, ['case', ['==', ['get', 'id'], selectedId], 10, 7],
        12, ['case', ['==', ['get', 'id'], selectedId], 16, 12],
      ])
    }
  }, [selectedId])

  // Fly to selected incident
  useEffect(() => {
    const map = mapRef.current
    if (!map || !selectedId) return
    const incident = MOCK_INCIDENTS.find(i => i.id === selectedId)
    if (!incident) return
    map.flyTo({
      center: [incident.lng, incident.lat],
      zoom: 14,
      duration: 1800,
      essential: true,
    })
  }, [selectedId])

  return <div ref={containerRef} className="map-container" />
}
