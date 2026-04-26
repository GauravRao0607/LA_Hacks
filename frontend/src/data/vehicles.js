export const VEHICLE_CONFIG = {
  fire:   { color: '#ef4444', label: 'F', name: 'Fire Truck',  bgColor: '#7f1d1d' },
  ems:    { color: '#f1f5f9', label: 'A', name: 'Ambulance',   bgColor: '#0f172a' },
  police: { color: '#2563eb', label: 'P', name: 'Police Unit', bgColor: '#1e1b4b' },
}

export const BASE_STATIONS = [
  { id: 'fire-1',   name: 'Fire Station 1',  type: 'fire',   lat: 29.7580, lng: -95.3670, count: 2 },
  { id: 'fire-2',   name: 'Fire Station 7',  type: 'fire',   lat: 29.7730, lng: -95.3855, count: 2 },
  { id: 'ems-1',    name: 'EMS Central',     type: 'ems',    lat: 29.7490, lng: -95.3780, count: 3 },
  { id: 'ems-2',    name: 'EMS North',       type: 'ems',    lat: 29.7710, lng: -95.3620, count: 2 },
  { id: 'police-1', name: 'HPD District 2',  type: 'police', lat: 29.7660, lng: -95.3510, count: 3 },
  { id: 'police-2', name: 'HPD District 5',  type: 'police', lat: 29.7430, lng: -95.3900, count: 2 },
]

// Expand stations into individual vehicle objects
let _id = 1
export const INITIAL_VEHICLES = BASE_STATIONS.flatMap(station =>
  Array.from({ length: station.count }, (_, i) => ({
    id:        `v${_id++}`,
    stationId: station.id,
    type:      station.type,
    callSign:  `${station.type.toUpperCase().slice(0, 3)}-${String(_id).padStart(2, '0')}`,
    status:    'idle',             // 'idle' | 'en-route' | 'on-scene'
    lat:       station.lat + (i % 2 === 0 ? 0.0005 : -0.0005),
    lng:       station.lng + (i % 2 === 0 ? 0.0008 : -0.0008),
    incidentId: null,
  }))
)

export function distanceKm(lat1, lng1, lat2, lng2) {
  const R = 6371
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}
