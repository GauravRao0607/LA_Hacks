import { useEffect } from 'react'
import { MapContainer, TileLayer, CircleMarker, useMap } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import { MOCK_INCIDENTS, TIER_COLORS } from '../data/mockIncidents'
import '../styles/Map.css'

const TIER_GLOW = {
  Critical: 'rgba(255, 59, 48, 0.25)',
  Urgent: 'rgba(255, 149, 0, 0.2)',
  Standard: 'rgba(255, 204, 0, 0.15)',
}

function FlyToIncident({ selectedId }) {
  const map = useMap()
  useEffect(() => {
    if (!selectedId) return
    const incident = MOCK_INCIDENTS.find(i => i.id === selectedId)
    if (incident) {
      map.flyTo([incident.lat, incident.lng], 14, { duration: 0.8 })
    }
  }, [selectedId, map])
  return null
}

export default function ThreatMap({ selectedId, onSelectIncident }) {
  return (
    <div className="map-container">
      <MapContainer
        center={[34.0522, -118.2437]}
        zoom={11}
        style={{ width: '100%', height: '100%' }}
        zoomControl={false}
      >
        <TileLayer
          url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
          attribution='&copy; <a href="https://carto.com/">CARTO</a>'
          maxZoom={19}
        />

        <FlyToIncident selectedId={selectedId} />

        {MOCK_INCIDENTS.map(incident => {
          const isSelected = incident.id === selectedId
          const color = TIER_COLORS[incident.tier]

          return (
            <div key={incident.id}>
              {/* Outer glow ring */}
              <CircleMarker
                center={[incident.lat, incident.lng]}
                radius={isSelected ? 32 : 24}
                pathOptions={{
                  color: 'transparent',
                  fillColor: color,
                  fillOpacity: isSelected ? 0.18 : 0.12,
                  weight: 0,
                }}
                interactive={false}
              />

              {/* Dashed pulse ring for Critical */}
              {incident.tier === 'Critical' && (
                <CircleMarker
                  center={[incident.lat, incident.lng]}
                  radius={isSelected ? 44 : 36}
                  pathOptions={{
                    color: color,
                    fillColor: 'transparent',
                    fillOpacity: 0,
                    weight: 1,
                    opacity: 0.4,
                    dashArray: '4 4',
                  }}
                  interactive={false}
                />
              )}

              {/* Core dot — clickable */}
              <CircleMarker
                center={[incident.lat, incident.lng]}
                radius={isSelected ? 10 : 7}
                pathOptions={{
                  color: color,
                  fillColor: color,
                  fillOpacity: 0.95,
                  weight: isSelected ? 2.5 : 1.5,
                  opacity: 1,
                }}
                eventHandlers={{
                  click: () => onSelectIncident(incident),
                }}
              />
            </div>
          )
        })}
      </MapContainer>
    </div>
  )
}
