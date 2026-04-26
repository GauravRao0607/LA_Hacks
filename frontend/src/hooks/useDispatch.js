import { useState, useCallback, useEffect, useRef } from 'react'
import { INITIAL_VEHICLES, BASE_STATIONS, distanceKm } from '../data/vehicles'

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN

async function fetchRoute(fromLng, fromLat, toLng, toLat) {
  try {
    const url = `https://api.mapbox.com/directions/v5/mapbox/driving/` +
      `${fromLng},${fromLat};${toLng},${toLat}` +
      `?geometries=geojson&overview=full&access_token=${MAPBOX_TOKEN}`
    const res  = await fetch(url)
    const data = await res.json()
    const route = data.routes?.[0]
    if (!route) throw new Error('no route')
    return {
      coords:    route.geometry.coordinates, // [[lng,lat], ...]
      duration:  route.duration * 1000,       // real driving time in ms
      distanceM: route.distance,
    }
  } catch {
    // Fallback: straight line at ~50 km/h
    const distKm = distanceKm(fromLat, fromLng, toLat, toLng)
    return {
      coords:    [[fromLng, fromLat], [toLng, toLat]],
      duration:  (distKm / 50) * 3_600_000,
      distanceM: distKm * 1000,
    }
  }
}

// Returns stations of the given type sorted by proximity to (lat, lng)
function nearestStationsForType(type, lat, lng) {
  return BASE_STATIONS
    .filter(s => s.type === type)
    .sort((a, b) =>
      distanceKm(a.lat, a.lng, lat, lng) -
      distanceKm(b.lat, b.lng, lat, lng)
    )
}

function interpolateRoute(coords, t) {
  if (!coords || coords.length < 2) return coords?.[0]
  const idx  = Math.min(Math.floor(t * (coords.length - 1)), coords.length - 2)
  const frac = t * (coords.length - 1) - idx
  const a    = coords[idx]
  const b    = coords[idx + 1]
  return [a[0] + (b[0] - a[0]) * frac, a[1] + (b[1] - a[1]) * frac]
}

export function useDispatch() {
  const [vehicles, setVehicles]         = useState(INITIAL_VEHICLES)
  const [dispatches, setDispatches]     = useState({}) // incidentId → dispatch record
  const [vehiclePositions, setPositions] = useState(() => {
    const stationMap = Object.fromEntries(BASE_STATIONS.map(s => [s.id, s]))
    return Object.fromEntries(
      INITIAL_VEHICLES.map(v => {
        const station = stationMap[v.stationId]
        return [v.id, [station?.lng ?? v.lng, station?.lat ?? v.lat]]
      })
    )
  })
  const rafRef = useRef(null)

  // Animation loop — runs while any vehicle is en-route
  useEffect(() => {
    const hasActive = Object.values(dispatches).some(d =>
      d.assignments.some(a => a.status === 'en-route')
    )
    if (!hasActive) { cancelAnimationFrame(rafRef.current); return }

    const tick = () => {
      const now = Date.now()
      const newPositions = {}
      let stillActive = false

      setDispatches(prev => {
        const next = { ...prev }
        Object.entries(next).forEach(([incId, dispatch]) => {
          dispatch.assignments.forEach(a => {
            if (a.status !== 'en-route') return
            if (!a.route || !a.startTime) {
              // Route still loading — hold vehicle at station origin
              if (a.originLng != null) newPositions[a.vehicleId] = [a.originLng, a.originLat]
              stillActive = true
              return
            }
            const t = Math.min((now - a.startTime) / a.duration, 1)
            newPositions[a.vehicleId] = interpolateRoute(a.route, t)
            if (t < 1) {
              stillActive = true
            } else if (a.status !== 'on-scene') {
              a.status    = 'on-scene'
              a.arrivedAt = now
            }
          })
          // Mark entire dispatch on-scene when all vehicles arrive
          if (dispatch.assignments.every(a => a.status === 'on-scene') &&
              dispatch.status !== 'on-scene') {
            dispatch.status = 'on-scene'
          }
        })
        return next
      })

      setPositions(prev => ({ ...prev, ...newPositions }))
      if (stillActive) rafRef.current = requestAnimationFrame(tick)
    }

    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [dispatches])

  const dispatch = useCallback(async (incident) => {
    const needed = incident.required_responders || {}
    const assignments = []

    setVehicles(prev => {
      const updated = [...prev]
      const used    = new Set()

      Object.entries(needed).forEach(([type, count]) => {
        if (!count) return

        // Work through stations nearest to the incident first
        const stations = nearestStationsForType(type, incident.lat, incident.lng)
        let remaining  = count

        for (const station of stations) {
          if (remaining <= 0) break
          const fromStation = updated
            .filter(v =>
              v.type === type &&
              v.status === 'idle' &&
              !used.has(v.id) &&
              v.stationId === station.id
            )
            .slice(0, remaining)

          fromStation.forEach(v => {
            used.add(v.id)
            // Carry station coords so routing starts from the station
            assignments.push({
              vehicleId:  v.id,
              type,
              status:     'fetching',
              originLat:  station.lat,
              originLng:  station.lng,
              stationName: station.name,
            })
            const idx = updated.findIndex(u => u.id === v.id)
            updated[idx] = { ...updated[idx], status: 'en-route', incidentId: incident.id }
            remaining--
          })
        }
      })

      return updated
    })

    // Add pending dispatch immediately so the panel appears
    setDispatches(prev => ({
      ...prev,
      [incident.id]: { incident, assignments, status: 'en-route', dispatchedAt: Date.now() },
    }))

    // Fetch real routes (from station → incident) in parallel
    const routeResults = await Promise.all(
      assignments.map(async a => {
        if (incident.lat == null) {
          return { ...a, status: 'en-route', route: null, duration: 600_000 } // 10 min default
        }
        const { coords, duration } = await fetchRoute(
          a.originLng, a.originLat, incident.lng, incident.lat
        )
        return { ...a, status: 'en-route', route: coords, duration, startTime: Date.now() }
      })
    )

    setDispatches(prev => ({
      ...prev,
      [incident.id]: {
        ...(prev[incident.id] || {}),
        assignments: routeResults,
        status: 'en-route',
      },
    }))
  }, [vehicles])

  const recallDispatch = useCallback((incidentId) => {
    setDispatches(prev => {
      const d = prev[incidentId]
      if (!d) return prev
      setVehicles(v => v.map(veh =>
        d.assignments.some(a => a.vehicleId === veh.id)
          ? { ...veh, status: 'idle', incidentId: null }
          : veh
      ))
      const next = { ...prev }
      delete next[incidentId]
      return next
    })
  }, [])

  // Build GeoJSON for map rendering
  const routeGeoJSON = {
    type: 'FeatureCollection',
    features: Object.values(dispatches).flatMap(d =>
      d.assignments
        .filter(a => a.route?.length > 1)
        .map(a => ({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: a.route },
          properties: { vehicleId: a.vehicleId, type: a.type, status: a.status },
        }))
    ),
  }

  const vehicleGeoJSON = {
    type: 'FeatureCollection',
    features: Object.values(dispatches).flatMap(d =>
      d.assignments.map(a => {
        const pos = vehiclePositions[a.vehicleId] || [0, 0]
        return {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: pos },
          properties: { vehicleId: a.vehicleId, type: a.type, status: a.status },
        }
      })
    ),
  }

  return {
    vehicles,
    dispatches,
    vehicleGeoJSON,
    routeGeoJSON,
    vehiclePositions,
    dispatch,
    recallDispatch,
  }
}
