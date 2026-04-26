import { useState, useCallback, useEffect, useRef } from 'react'
import { API_URL, API_HEADERS } from './useIncidents'

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN

function distanceKm(lat1, lng1, lat2, lng2) {
  const R = 6371
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

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
      coords:    route.geometry.coordinates,
      duration:  route.duration * 1000,
      distanceM: route.distance,
    }
  } catch {
    const distKm = distanceKm(fromLat, fromLng, toLat, toLng)
    return {
      coords:    [[fromLng, fromLat], [toLng, toLat]],
      duration:  (distKm / 50) * 3_600_000,
      distanceM: distKm * 1000,
    }
  }
}

// Backend lookup: nearest real-world station of a given type to the incident.
async function fetchNearestStation(type, lat, lng) {
  try {
    const url = `${API_URL}/stations/nearest?lat=${lat}&lng=${lng}&type=${type}`
    const res = await fetch(url, { headers: API_HEADERS })
    if (!res.ok) return null
    return await res.json()  // { type, name, address, lat, lng, distance_m, place_id }
  } catch (e) {
    console.error('[dispatch] nearest station fetch failed', type, e)
    return null
  }
}

function interpolateRoute(coords, t) {
  if (!coords || coords.length < 2) return coords?.[0]
  const idx  = Math.min(Math.floor(t * (coords.length - 1)), coords.length - 2)
  const frac = t * (coords.length - 1) - idx
  const a    = coords[idx]
  const b    = coords[idx + 1]
  return [a[0] + (b[0] - a[0]) * frac, a[1] + (b[1] - a[1]) * frac]
}

export function useDispatch(selectedIncidentId = null) {
  const [dispatches, setDispatches]      = useState({})
  const [vehiclePositions, setPositions] = useState({})
  const [availableVehicles, setAvailable] = useState([]) // freed vehicles with last-known position
  const availableRef       = useRef([])
  const vehiclePositionsRef = useRef({})
  const rafRef = useRef(null)

  useEffect(() => { availableRef.current       = availableVehicles }, [availableVehicles])
  useEffect(() => { vehiclePositionsRef.current = vehiclePositions }, [vehiclePositions])

  // When an incident is selected, narrow the map's vehicles / routes /
  // stations to that incident only. With nothing selected, show everything.
  const visibleDispatches = selectedIncidentId
    ? (dispatches[selectedIncidentId] ? { [selectedIncidentId]: dispatches[selectedIncidentId] } : {})
    : dispatches

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
              if (a.originLng != null) newPositions[a.vehicleId] = [a.originLng, a.originLat]
              stillActive = true
              return
            }
            const t = (now - a.startTime) / a.duration
            if (t < 0) {
              // Vehicle hasn't departed yet — hold at origin
              newPositions[a.vehicleId] = [a.originLng, a.originLat]
              stillActive = true
              return
            }
            const tClamped = Math.min(t, 1)
            newPositions[a.vehicleId] = interpolateRoute(a.route, tClamped)
            if (tClamped < 1) {
              stillActive = true
            } else if (a.status !== 'on-scene') {
              a.status    = 'on-scene'
              a.arrivedAt = now
            }
          })
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
    if (incident.lat == null || incident.lng == null) {
      console.warn('[dispatch] incident has no coords, skipping')
      return
    }

    const needed = Object.entries(incident.required_responders || {})
      .filter(([, count]) => count > 0)

    // Look up the nearest real station for each required type, in parallel.
    const stationsByType = {}
    await Promise.all(needed.map(async ([type]) => {
      const s = await fetchNearestStation(type, incident.lat, incident.lng)
      if (s) stationsByType[type] = s
    }))

    // Build assignments — prefer available redeployed vehicles when closer than the station.
    const assignments = []
    const claimedIds  = new Set()
    let vid = 0

    needed.forEach(([type, count]) => {
      const station     = stationsByType[type]
      const stationDist = station
        ? distanceKm(station.lat, station.lng, incident.lat, incident.lng)
        : Infinity

      for (let i = 0; i < count; i++) {
        // Find closest unclaimed available vehicle of this type
        let best = null, bestDist = Infinity
        for (const v of availableRef.current) {
          if (v.type !== type || claimedIds.has(v.vehicleId)) continue
          const d = distanceKm(v.lat, v.lng, incident.lat, incident.lng)
          if (d < bestDist) { bestDist = d; best = v }
        }

        if (best) {
          // Always prefer a vehicle already in the field over spawning a new one
          claimedIds.add(best.vehicleId)
          assignments.push({
            vehicleId:        best.vehicleId,
            type,
            status:           'fetching',
            originLat:        best.lat,
            originLng:        best.lng,
            stationName:      'Redeployed unit',
            stationAddress:   '',
            stationDistanceM: Math.round(bestDist * 1000),
            redeployed:       true,
          })
        } else if (station) {
          // No available unit — spawn fresh from the nearest station
          assignments.push({
            vehicleId:        `${incident.id}-${type}-${vid++}`,
            type,
            status:           'fetching',
            originLat:        station.lat,
            originLng:        station.lng,
            stationName:      station.name,
            stationAddress:   station.address,
            stationDistanceM: station.distance_m,
          })
        } else {
          console.warn(`[dispatch] no source for type '${type}' unit ${i + 1}, skipping`)
        }
      }
    })

    // Remove claimed vehicles from the available pool
    if (claimedIds.size > 0)
      setAvailable(v => v.filter(av => !claimedIds.has(av.vehicleId)))

    // Show pending dispatch immediately.
    setDispatches(prev => ({
      ...prev,
      [incident.id]: { incident, assignments, status: 'en-route', dispatchedAt: Date.now() },
    }))

    // Fetch real driving routes (station → incident) in parallel.
    // Stagger startTime by 3s per vehicle so same-route units don't overlap as one dot.
    const routeBase = Date.now()
    const routeResults = await Promise.all(
      assignments.map(async (a, i) => {
        const { coords, duration } = await fetchRoute(
          a.originLng, a.originLat, incident.lng, incident.lat
        )
        return { ...a, status: 'en-route', route: coords, duration, startTime: routeBase + i * 3000 }
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
  }, [])

  const recallDispatch = useCallback((incidentId) => {
    setDispatches(prev => {
      const d = prev[incidentId]
      if (d) {
        const freed = d.assignments.map(a => {
          const pos = vehiclePositionsRef.current[a.vehicleId]
          return {
            vehicleId: a.vehicleId,
            type:      a.type,
            lat:       pos ? pos[1] : a.originLat,
            lng:       pos ? pos[0] : a.originLng,
          }
        })
        setAvailable(v => [...v, ...freed])
      }
      const next = { ...prev }
      delete next[incidentId]
      return next
    })
  }, [])

  // Build GeoJSON for map rendering
  const routeGeoJSON = {
    type: 'FeatureCollection',
    features: Object.values(visibleDispatches).flatMap(d =>
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
    features: [
      // Active / en-route / on-scene vehicles (filtered by selected incident)
      ...Object.values(visibleDispatches).flatMap(d =>
        d.assignments.map(a => {
          const pos = vehiclePositions[a.vehicleId] || [a.originLng, a.originLat]
          return {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: pos },
            properties: { vehicleId: a.vehicleId, type: a.type, status: a.status },
          }
        })
      ),
      // Available (freed) vehicles — always visible so they don't disappear on resolve
      ...availableVehicles.map(v => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [v.lng, v.lat] },
        properties: { vehicleId: v.vehicleId, type: v.type, status: 'available' },
      })),
    ],
  }

  // Unique stations from all active dispatches — for rendering on the map.
  const stationGeoJSON = (() => {
    const seen = new Set()
    const features = []
    Object.values(visibleDispatches).forEach(d => {
      d.assignments.forEach(a => {
        const key = `${a.originLat},${a.originLng}`
        if (seen.has(key)) return
        seen.add(key)
        features.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [a.originLng, a.originLat] },
          properties: { name: a.stationName, type: a.type },
        })
      })
    })
    return { type: 'FeatureCollection', features }
  })()

  return {
    dispatches,
    vehicleGeoJSON,
    routeGeoJSON,
    stationGeoJSON,
    vehiclePositions,
    dispatch,
    recallDispatch,
  }
}
