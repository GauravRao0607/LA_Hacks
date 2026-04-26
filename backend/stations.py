"""
Look up the nearest dispatchable station (police / fire / EMS / rescue) to a
given lat/lng using Google Places Nearby Search (New).

We only call Google when the incident actually fires a Dispatch action — and
we cache results by rounded coordinates so repeated dispatches in the same
neighborhood don't burn the quota.
"""

import math
import os

import httpx

GOOGLE_PLACES_NEARBY_URL = "https://places.googleapis.com/v1/places:searchNearby"

# Internal unit_type → Google Place type(s) to query.
# - "ems" maps to hospital because that's where ambulance services dispatch from.
# - "rescue" piggybacks on fire stations (rescue ops are typically run by fire).
TYPE_MAP: dict[str, list[str]] = {
    "fire":   ["fire_station"],
    "ems":    ["hospital"],
    "police": ["police"],
    "rescue": ["fire_station"],
}

# Google caps locationRestriction circle radius at 50km.
NEAREST_RADIUS_M = 50_000.0


def _haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    R = 6_371_000
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


# Cache key: (rounded lat to 3 decimals ≈ 110m, rounded lng, type) → station dict.
_CACHE: dict[tuple[float, float, str], dict] = {}


async def find_nearest_station(lat: float, lng: float, unit_type: str) -> dict | None:
    """Return the nearest station of `unit_type` to (lat,lng), or None."""
    types = TYPE_MAP.get(unit_type)
    if not types:
        print(f"[stations] unknown unit_type '{unit_type}'")
        return None

    cache_key = (round(lat, 3), round(lng, 3), unit_type)
    if cache_key in _CACHE:
        return _CACHE[cache_key]

    api_key = os.getenv("GOOGLE_PLACES_API_KEY")
    if not api_key:
        print("[stations] GOOGLE_PLACES_API_KEY not set")
        return None

    body = {
        "includedTypes":   types,
        "maxResultCount":  1,
        "rankPreference":  "DISTANCE",
        "locationRestriction": {
            "circle": {
                "center": {"latitude": lat, "longitude": lng},
                "radius": NEAREST_RADIUS_M,
            },
        },
    }

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(
                GOOGLE_PLACES_NEARBY_URL,
                headers={
                    "Content-Type":     "application/json",
                    "X-Goog-Api-Key":   api_key,
                    "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.location",
                },
                json=body,
            )
            resp.raise_for_status()
            places = resp.json().get("places", [])
            if not places:
                print(f"[stations] no '{unit_type}' near ({lat:.4f},{lng:.4f})")
                return None

            top = places[0]
            loc = top.get("location") or {}
            station_lat = loc.get("latitude")
            station_lng = loc.get("longitude")
            if station_lat is None or station_lng is None:
                return None

            station = {
                "type":       unit_type,
                "name":       (top.get("displayName") or {}).get("text", "Unknown"),
                "address":    top.get("formattedAddress", ""),
                "lat":        station_lat,
                "lng":        station_lng,
                "place_id":   top.get("id", ""),
                "distance_m": int(_haversine_m(lat, lng, station_lat, station_lng)),
            }
            print(
                f"[stations] nearest {unit_type} to ({lat:.4f},{lng:.4f}) → "
                f"'{station['name']}' ({station['distance_m']}m)"
            )
            _CACHE[cache_key] = station
            return station

    except httpx.HTTPStatusError as e:
        print(f"[stations] HTTP {e.response.status_code}: {e.response.text[:200]}")
    except Exception as e:
        print(f"[stations] error: {e}")
    return None
