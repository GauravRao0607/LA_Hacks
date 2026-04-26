import asyncio
import json
import math
import os
import re
import sys
import uuid
from datetime import datetime
from typing import Any, Optional

# Force line-buffered stdout so print() shows up in nohup-redirected logs
sys.stdout.reconfigure(line_buffering=True)

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from dotenv import load_dotenv

try:
    import anthropic as _anthropic
    _ANTHROPIC_AVAILABLE = True
except ImportError:
    _ANTHROPIC_AVAILABLE = False

load_dotenv()

import db        # noqa: E402  (must come after load_dotenv so db.init_pool sees SUPABASE_DB_URL)
import scoring   # noqa: E402
import stations  # noqa: E402

app = FastAPI(title="CrisisLine AI Backend")


@app.on_event("startup")
async def _startup() -> None:
    await db.init_pool()
    await db.hydrate(calls, incidents)


@app.on_event("shutdown")
async def _shutdown() -> None:
    await db.close_pool()

# ── CORS ──────────────────────────────────────────────────────────────────────
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Request logging middleware ─────────────────────────────────────────────────
@app.middleware("http")
async def log_requests(request: Request, call_next):
    body = await request.body()
    print(f"\n[{datetime.utcnow().isoformat()}] {request.method} {request.url.path}")
    if body:
        try:
            print(f"  body: {json.dumps(json.loads(body), indent=2)}")
        except Exception:
            print(f"  body: {body.decode('utf-8', errors='replace')}")
    return await call_next(request)


# ── Config / constants ────────────────────────────────────────────────────────
CLUSTER_RADIUS_M = 300         # max distance from incident centroid to merge
CLUSTER_WINDOW_S = 30 * 60     # incident must have been updated within last 30 min
TIME_DECAY_SLOPE = 0.4         # urgency points added per minute in queue
TIME_DECAY_CAP = 20            # max time-decay bonus

# Calls only cluster within the same emergency family. Anything not listed is
# treated as its own family (key is the lowercased emergency_type itself).
EMERGENCY_FAMILIES = {
    "fire":                "fire_complex",
    "structural collapse": "fire_complex",
    "cardiac arrest":      "medical",
    "medical":             "medical",
    "shooting":            "violence",
    "stabbing":            "violence",
    "flooding":            "water",
    "car accident":        "traffic",
}

CRITICAL_HAZARDS = ["fire spreading", "gas leak", "weapons", "rising water"]


# ── In-memory stores ──────────────────────────────────────────────────────────
calls: dict[str, dict] = {}
incidents: dict[str, dict] = {}


# ── Schemas ───────────────────────────────────────────────────────────────────
class CallPayload(BaseModel):
    caller_name: str
    location: str
    emergency_type: Optional[str] = "unknown"
    situation: Optional[str] = ""
    num_people: Optional[Any] = 1
    injuries: Optional[str] = "none"
    hazards: Optional[str] = "none"
    mobility: Optional[str] = "mobile"
    timestamp: Optional[str] = None


# ── Input normalization ────────────────────────────────────────────────────────
WORD_TO_INT = {
    "zero": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5,
    "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10,
    "eleven": 11, "twelve": 12, "fifteen": 15, "twenty": 20,
}

def normalize_num_people(val: Any) -> int:
    if val is None:
        return 1
    if isinstance(val, int):
        return max(1, val)
    s = str(val).strip().lower()
    if s.isdigit():
        return max(1, int(s))
    if s in WORD_TO_INT:
        return max(1, WORD_TO_INT[s])
    m = re.search(r'\d+', s)
    return max(1, int(m.group())) if m else 1

def normalize_str(val: Any, default: str = "none") -> str:
    if not val:
        return default
    return str(val).strip()

def normalize_payload(raw: dict) -> dict:
    return {
        "caller_name":    normalize_str(raw.get("caller_name"), "Unknown"),
        "location":       normalize_str(raw.get("location"), "Unknown location"),
        "emergency_type": normalize_str(raw.get("emergency_type"), "unknown"),
        "situation":      normalize_str(raw.get("situation"), ""),
        "num_people":     normalize_num_people(raw.get("num_people")),
        "injuries":       normalize_str(raw.get("injuries"), "none"),
        "hazards":        normalize_str(raw.get("hazards"), "none"),
        "mobility":       normalize_str(raw.get("mobility"), "mobile"),
        "timestamp":      raw.get("timestamp"),
    }


# ── ElevenLabs payload extraction ─────────────────────────────────────────────
def extract_elevenlabs_params(body: dict) -> dict:
    if "parameters" in body and isinstance(body["parameters"], dict):
        return body["parameters"]
    if "tool_call" in body and isinstance(body.get("tool_call"), dict):
        tc = body["tool_call"]
        if "parameters" in tc:
            return tc["parameters"]
    return body


def _conversation_history_entries(body: dict) -> list[dict]:
    """
    Pull conversation entries out of a post_call_transcription body. ElevenLabs
    sometimes puts them in custom_llm_extra_body.system__conversation_history
    (older calls), and sometimes only in data.transcript (current). Try both.
    """
    try:
        data = body.get("data", {})
        client_data = data.get("conversation_initiation_client_data", {})
        extra = client_data.get("custom_llm_extra_body", {})
        history_raw = extra.get("system__conversation_history", "")
        if history_raw:
            entries = json.loads(history_raw).get("entries", []) or []
            if entries:
                return entries
        transcript = data.get("transcript")
        if isinstance(transcript, list):
            return transcript
    except Exception as e:
        print(f"[history] entries parse error: {e}")
    return []


def _tool_request_entries(entry: dict) -> list[dict]:
    """Field name is 'tool_requests' in conversation_history, 'tool_calls' in transcript."""
    return entry.get("tool_requests") or entry.get("tool_calls") or []


def tool_call_already_succeeded(body: dict) -> bool:
    """
    Did the agent's tool call already fire successfully during this call?
    If so, the live `/webhook/call` path already created/merged the incident
    and the post_call_transcription is a duplicate — skip it.
    """
    for entry in _conversation_history_entries(body):
        if entry.get("role") != "agent":
            continue
        for result in entry.get("tool_results", []) or []:
            if result.get("is_error"):
                continue
            value = result.get("result_value") or ""
            if isinstance(value, str) and '"id"' in value and '"call_ids"' in value:
                return True
    return False


def extract_params_from_conversation_history(body: dict) -> dict | None:
    """
    When the live tool call failed (e.g. 404 from a misconfigured URL),
    ElevenLabs still sends a post_call_transcription webhook containing the
    attempted tool params. Pull them out so we don't lose the call.
    """
    try:
        for entry in reversed(_conversation_history_entries(body)):
            if entry.get("role") != "agent":
                continue
            for req in _tool_request_entries(entry):
                raw = req.get("params_as_json") or "{}"
                # In transcript-style entries this is a JSON string; in
                # conversation_history-style it's already a dict in some cases.
                params = raw if isinstance(raw, dict) else json.loads(raw)
                if params.get("location"):
                    print(f"[history] recovered tool params: {params}")
                    return params
    except Exception as e:
        print(f"[history] extraction error: {e}")
    return None


# ── Geo / family helpers ──────────────────────────────────────────────────────
def emergency_family(etype: str) -> str:
    et = (etype or "").lower().strip()
    return EMERGENCY_FAMILIES.get(et, et or "unknown")


def haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    R = 6_371_000
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))



# ── Resource allocation ───────────────────────────────────────────────────────
def required_responders(incident: dict) -> dict[str, int]:
    icalls = [calls[cid] for cid in incident["call_ids"] if cid in calls]
    n = len(icalls)
    family = incident["family"]

    # Baseline mix per family (1-2 calls)
    base = {
        "fire_complex": {"fire": 2, "ems": 1, "police": 1},
        "medical":      {"fire": 0, "ems": 1, "police": 0},
        "violence":     {"fire": 0, "ems": 1, "police": 2},
        "water":        {"fire": 1, "ems": 1, "police": 1},
        "traffic":      {"fire": 1, "ems": 1, "police": 1},
    }.get(family, {"fire": 0, "ems": 1, "police": 1})

    units = dict(base)

    # Scale by call volume
    if 3 <= n <= 5:
        dom = max(units, key=lambda k: units[k]) if any(units.values()) else "ems"
        units[dom] += 1
    elif 6 <= n <= 10:
        ranked = sorted(units, key=lambda k: units[k], reverse=True)
        units[ranked[0]] += 2
        units[ranked[1]] += 1
    elif n >= 11:
        # Mass response floor
        for k, v in {"fire": 4, "ems": 4, "police": 3}.items():
            units[k] = max(units[k], v)
        extra = (n - 10) // 5
        for k in units:
            units[k] += extra

    # Hazard / injury shifts
    aggregate_hazards = " ".join((c["hazards"] or "").lower() for c in icalls)
    if "gas leak" in aggregate_hazards or "fire spreading" in aggregate_hazards:
        units["fire"] += 1
    if "weapons" in aggregate_hazards:
        units["police"] += 1
    severe_count = sum(
        1 for c in icalls
        if any(k in (c["injuries"] or "").lower()
               for k in ("unconscious", "not breathing", "heavy bleeding", "severe"))
    )
    if severe_count >= 2:
        units["ems"] += 1

    # Scale by number of people across all calls
    max_people = max((c.get("num_people") or 1) for c in icalls) if icalls else 1
    if max_people >= 500:
        for k, v in {"fire": 5, "ems": 6, "police": 4}.items():
            units[k] = max(units[k], v)
    elif max_people >= 50:
        for k, v in {"fire": 3, "ems": 4, "police": 3}.items():
            units[k] = max(units[k], v)
    elif max_people >= 10:
        for k, v in {"fire": 2, "ems": 3, "police": 2}.items():
            units[k] = max(units[k], v)
    elif max_people >= 5:
        for k, v in {"fire": 1, "ems": 2, "police": 1}.items():
            units[k] = max(units[k], v)

    return units


# ── Address correction via Claude ─────────────────────────────────────────────
async def correct_address_with_claude(address: str) -> str | None:
    if not _ANTHROPIC_AVAILABLE:
        return None
    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        return None
    try:
        client = _anthropic.AsyncAnthropic(api_key=api_key)
        msg = await client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=80,
            messages=[{
                "role": "user",
                "content": (
                    "A 911 caller gave this address — it may have speech-to-text "
                    "errors or misheard street names. Correct it to the most likely "
                    "real street address. Return ONLY the corrected address, nothing else.\n\n"
                    f"Transcribed: {address}"
                )
            }]
        )
        return msg.content[0].text.strip()
    except Exception as e:
        print(f"[correct_address] error: {e}")
        return None


# ── Google Places Text Search ─────────────────────────────────────────────────
GOOGLE_PLACES_TEXT_SEARCH_URL = "https://places.googleapis.com/v1/places:searchText"

# Bias text-search results toward LA county. Adjust if you change demo region.
LA_CENTER = {"latitude": 34.0522, "longitude": -118.2437}
LA_BIAS_RADIUS_M = 50_000  # Google caps locationBias circle radius at 50km


async def _google_places_resolve(address: str) -> tuple[float | None, float | None, str | None]:
    """
    Resolve a spoken/messy address using Google Places Text Search (New).
    Single round-trip — returns coords + canonical formatted address.
    Designed to handle filler words ("near the music center"), spelled-out
    numbers ("three fifty south grand"), and partial inputs.

    Returns (lat, lng, formatted_address) or (None, None, None) on failure.
    """
    api_key = os.getenv("GOOGLE_PLACES_API_KEY")
    if not api_key or not address or not address.strip():
        return None, None, None

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(
                GOOGLE_PLACES_TEXT_SEARCH_URL,
                headers={
                    "Content-Type":     "application/json",
                    "X-Goog-Api-Key":   api_key,
                    "X-Goog-FieldMask": "places.location,places.formattedAddress,places.displayName,places.id",
                },
                json={
                    "textQuery":     address,
                    "languageCode":  "en",
                    "regionCode":    "us",
                    "maxResultCount": 1,
                    "locationBias": {
                        "circle": {"center": LA_CENTER, "radius": LA_BIAS_RADIUS_M},
                    },
                },
            )
            resp.raise_for_status()
            places = resp.json().get("places", [])
            if not places:
                print(f"[google] no text-search results for '{address}'")
                return None, None, None

            top = places[0]
            loc = top.get("location") or {}
            lat = loc.get("latitude")
            lng = loc.get("longitude")
            formatted = top.get("formattedAddress") or (top.get("displayName") or {}).get("text")
            if lat is None or lng is None:
                return None, None, formatted
            print(f"[google] '{address}' → '{formatted}' @ {lat:.4f},{lng:.4f}")
            return lat, lng, formatted

    except httpx.HTTPStatusError as e:
        print(f"[google] HTTP {e.response.status_code}: {e.response.text[:200]}")
    except Exception as e:
        print(f"[google] error for '{address}': {e}")
    return None, None, None


# ── Geocoding — multi-strategy ────────────────────────────────────────────────
_MAPBOX_TOKEN = lambda: os.getenv("MAPBOX_ACCESS_TOKEN") or os.getenv("VITE_MAPBOX_TOKEN")


async def _geocode_v6(addr: str, token: str) -> tuple[float | None, float | None]:
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(
                "https://api.mapbox.com/search/geocode/v6/forward",
                params={
                    "q": addr,
                    "access_token": token,
                    "types": "address,place,street",
                    "limit": 1,
                },
            )
            resp.raise_for_status()
            features = resp.json().get("features", [])
            if features:
                coords = features[0]["geometry"]["coordinates"]
                print(f"[geocode/v6] '{addr}' → {coords[1]:.4f},{coords[0]:.4f}")
                return coords[1], coords[0]
    except Exception as e:
        print(f"[geocode/v6] error for '{addr}': {e}")
    return None, None


async def _geocode_suggest(addr: str, token: str) -> tuple[float | None, float | None]:
    """Mapbox Search Box Suggest — handles fuzzy / misheard street names."""
    session = str(uuid.uuid4())
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            suggest = await client.get(
                "https://api.mapbox.com/search/searchbox/v1/suggest",
                params={
                    "q": addr,
                    "access_token": token,
                    "session_token": session,
                    "types": "address,street",
                    "limit": 1,
                },
            )
            suggest.raise_for_status()
            suggestions = suggest.json().get("suggestions", [])
            if not suggestions:
                return None, None
            mapbox_id = suggestions[0].get("mapbox_id")
            if not mapbox_id:
                return None, None
            retrieve = await client.get(
                f"https://api.mapbox.com/search/searchbox/v1/retrieve/{mapbox_id}",
                params={"access_token": token, "session_token": session},
            )
            retrieve.raise_for_status()
            features = retrieve.json().get("features", [])
            if features:
                coords = features[0]["geometry"]["coordinates"]
                print(f"[geocode/suggest] '{addr}' → {coords[1]:.4f},{coords[0]:.4f}")
                return coords[1], coords[0]
    except Exception as e:
        print(f"[geocode/suggest] error for '{addr}': {e}")
    return None, None


async def geocode(address: str) -> tuple[float | None, float | None]:
    token = _MAPBOX_TOKEN()
    if not token:
        return None, None

    # Strategy 1: exact query
    lat, lng = await _geocode_v6(address, token)
    if lat is not None:
        return lat, lng

    # Strategy 2: Mapbox Search Box Suggest (fuzzy / misheard street names)
    lat, lng = await _geocode_suggest(address, token)
    if lat is not None:
        return lat, lng

    # Strategy 3: strip house number and search just the street name
    stripped = re.sub(r'^\d+\s+', '', address).strip()
    if stripped != address:
        lat, lng = await _geocode_v6(stripped, token)
        if lat is not None:
            return lat, lng

    # Strategy 5: Claude correction (only if API key is configured)
    corrected = await correct_address_with_claude(address)
    if corrected and corrected.lower() != address.lower():
        print(f"[geocode] Claude corrected '{address}' → '{corrected}'")
        lat, lng = await _geocode_v6(corrected, token)
        if lat is not None:
            return lat, lng

    print(f"[geocode] all strategies failed for '{address}'")
    return None, None


async def resolve_address(address: str) -> tuple[float | None, float | None, str | None]:
    """
    Resolve a spoken/raw address to (lat, lng, canonical_address).
    Try Google Places Autocomplete first (best at fuzzy spoken input),
    fall back to the Mapbox pipeline.
    """
    lat, lng, formatted = await _google_places_resolve(address)
    if lat is not None and lng is not None:
        return lat, lng, formatted

    lat, lng = await geocode(address)
    return lat, lng, None


# ── Call building & clustering ────────────────────────────────────────────────
async def build_call(raw: dict, lat: float | None = None, lng: float | None = None) -> dict:
    normalized = normalize_payload(raw)
    payload = CallPayload(**normalized)
    if lat is None or lng is None:
        lat, lng, canonical = await resolve_address(payload.location)
        if canonical:
            payload.location = canonical  # show Google's exact address on the map
    score, tier = scoring.score_call(payload)
    return {
        "id":             str(uuid.uuid4()),
        "incident_id":    None,
        "caller_name":    payload.caller_name,
        "location":       payload.location,
        "lat":            lat,
        "lng":            lng,
        "emergency_type": payload.emergency_type,
        "situation":      payload.situation or "",
        "num_people":     payload.num_people,
        "injuries":       payload.injuries,
        "hazards":        payload.hazards,
        "mobility":       payload.mobility,
        "call_score":     score,
        "call_tier":      tier,
        "timestamp":      payload.timestamp or datetime.utcnow().isoformat(),
    }


def find_matching_incident(call: dict) -> str | None:
    if call["lat"] is None or call["lng"] is None:
        return None
    family = emergency_family(call["emergency_type"])
    now_ts = datetime.utcnow().timestamp()

    best_id: str | None = None
    best_dist = float("inf")
    for inc in incidents.values():
        if inc["status"] != "active":
            continue
        if inc["family"] != family:
            continue
        if inc["centroid_lat"] is None or inc["centroid_lng"] is None:
            continue
        updated_ts = datetime.fromisoformat(inc["updated_at"]).timestamp()
        if now_ts - updated_ts > CLUSTER_WINDOW_S:
            continue
        dist = haversine_m(call["lat"], call["lng"], inc["centroid_lat"], inc["centroid_lng"])
        if dist <= CLUSTER_RADIUS_M and dist < best_dist:
            best_dist = dist
            best_id = inc["id"]
    return best_id


def recompute_centroid(incident: dict) -> None:
    pts = [
        (calls[cid]["lat"], calls[cid]["lng"])
        for cid in incident["call_ids"]
        if cid in calls and calls[cid]["lat"] is not None and calls[cid]["lng"] is not None
    ]
    if not pts:
        incident["centroid_lat"] = None
        incident["centroid_lng"] = None
        return
    incident["centroid_lat"] = sum(p[0] for p in pts) / len(pts)
    incident["centroid_lng"] = sum(p[1] for p in pts) / len(pts)


def update_incident_aggregates(incident: dict) -> None:
    """Update everything except score/tier (Gemini owns those, set elsewhere)."""
    recompute_centroid(incident)
    icalls = [calls[cid] for cid in incident["call_ids"] if cid in calls]
    if icalls:
        # Use the most recent call as the canonical face of the incident.
        latest = max(icalls, key=lambda c: c.get("timestamp", ""))
        incident["primary_emergency_type"] = latest["emergency_type"]
        incident["location_label"] = latest["location"]
    incident["updated_at"] = datetime.utcnow().isoformat()


async def _score_with_gemini_and_persist(incident: dict) -> None:
    """Synchronous-style scoring helper used by mutation paths."""
    icalls = [calls[cid] for cid in incident["call_ids"] if cid in calls]
    score, tier, responders = await scoring.score_incident_with_gemini(incident, icalls)
    incident["score"] = score
    incident["tier"] = tier
    incident["required_responders"] = responders
    incident["updated_at"] = datetime.utcnow().isoformat()


async def create_incident_for_call(call: dict) -> dict:
    iid = str(uuid.uuid4())
    now = datetime.utcnow().isoformat()
    incident = {
        "id":                     iid,
        "call_ids":               [call["id"]],
        "family":                 emergency_family(call["emergency_type"]),
        "centroid_lat":           call["lat"],
        "centroid_lng":           call["lng"],
        "primary_emergency_type": call["emergency_type"],
        "location_label":         call["location"],
        "score":                  50,           # placeholder until Gemini responds
        "tier":                   "Urgent",     # safe default
        "required_responders":    {},
        "created_at":             now,
        "updated_at":             now,
        "status":                 "active",
    }
    incidents[iid] = incident
    call["incident_id"] = iid
    update_incident_aggregates(incident)
    await _score_with_gemini_and_persist(incident)
    asyncio.create_task(db.save_call(call))
    asyncio.create_task(db.save_incident(incident))
    return incident


async def merge_call_into_incident(call: dict, incident_id: str) -> dict:
    incident = incidents[incident_id]
    incident["call_ids"].append(call["id"])
    call["incident_id"] = incident_id
    update_incident_aggregates(incident)
    await _score_with_gemini_and_persist(incident)
    asyncio.create_task(db.save_call(call))
    asyncio.create_task(db.save_incident(incident))
    return incident


def serialize_incident(incident: dict) -> dict:
    icalls = [calls[cid] for cid in incident["call_ids"] if cid in calls]
    icalls_sorted = sorted(icalls, key=lambda c: c["timestamp"])
    return {
        **incident,
        "calls":       icalls_sorted,
        "call_count":  len(icalls_sorted),
    }


# ── Endpoints ─────────────────────────────────────────────────────────────────
@app.get("/")
def health_check():
    active = sum(1 for i in incidents.values() if i["status"] == "active")
    return {"status": "ok", "active_incidents": active, "total_calls": len(calls)}


@app.post("/webhook/call", status_code=201)
async def receive_call(request: Request):
    body = await request.json()

    # post_call_transcription = end-of-call summary. ElevenLabs sends it
    # whether the tool fired or not, so we have to dedupe against the live
    # tool call that already created an incident.
    if body.get("type") == "post_call_transcription":
        if tool_call_already_succeeded(body):
            print("[receive_call] tool already fired during call — skipping post_call duplicate")
            return {"detail": "tool already fired, no action"}
        params = extract_params_from_conversation_history(body)
        if not params:
            transcript_raw = (body.get("data") or {}).get("transcript", "")
            params = await extract_from_transcript_with_claude(transcript_raw)
        if not params or not params.get("location"):
            print("[receive_call] post_call_transcription: no location found, skipping")
            return {"detail": "no location found"}
    else:
        params = extract_elevenlabs_params(body)

    call = await build_call(params)
    calls[call["id"]] = call

    match = find_matching_incident(call)
    if match:
        incident = await merge_call_into_incident(call, match)
    else:
        incident = await create_incident_for_call(call)
    return serialize_incident(incident)


@app.post("/webhook/call-end", status_code=200)
async def call_end(request: Request):
    body = await request.json()
    print(f"\n[call-end] {json.dumps(body, indent=2)}")

    recent_cutoff = datetime.utcnow().timestamp() - 600
    tool_fired = any(
        datetime.fromisoformat(c["timestamp"]).timestamp() > recent_cutoff
        for c in calls.values()
    )
    if not tool_fired:
        transcript_raw = body.get("transcript", "")
        extracted = await extract_from_transcript_with_claude(transcript_raw)
        if extracted.get("location"):
            call = await build_call(extracted)
            calls[call["id"]] = call
            match = find_matching_incident(call)
            if match:
                incident = await merge_call_into_incident(call, match)
            else:
                incident = await create_incident_for_call(call)
            print(f"[call-end] fallback processed → incident {incident['id']}")
            return {"detail": "fallback processed", "incident": serialize_incident(incident)}
        print("[call-end] no location found in transcript, skipping")

    return {"detail": "ok"}


# ── Transcript helpers ────────────────────────────────────────────────────────
def _flatten_transcript(transcript_raw) -> tuple[str, str]:
    """Return (situation, full_text). situation = caller's first utterance."""
    situation = ""
    if isinstance(transcript_raw, list):
        for msg in transcript_raw:
            role = (msg.get("role") or "").lower()
            text = (msg.get("message") or msg.get("text") or "").strip()
            if role in ("user", "human", "caller") and text:
                situation = text
                break
        full_text = " ".join(
            (m.get("message") or m.get("text") or "") for m in transcript_raw
        )
    else:
        full_text = str(transcript_raw)
    return situation, full_text


# ── Claude transcript extraction ─────────────────────────────────────────────
async def extract_from_transcript_with_claude(transcript_raw) -> dict:
    if not _ANTHROPIC_AVAILABLE:
        return extract_from_transcript(transcript_raw)
    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        return extract_from_transcript(transcript_raw)

    if isinstance(transcript_raw, list):
        formatted = "\n".join(
            f"{(m.get('role') or 'agent').upper()}: {m.get('message') or m.get('text') or ''}"
            for m in transcript_raw
        )
    else:
        formatted = str(transcript_raw)

    try:
        client = _anthropic.AsyncAnthropic(api_key=api_key)
        msg = await client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=400,
            messages=[{
                "role": "user",
                "content": (
                    "Extract emergency information from this 911 call transcript. "
                    "Return a JSON object with these exact fields:\n"
                    "- caller_name: caller's first name (\"Unknown\" if not given)\n"
                    "- location: street address, intersection, or landmark (\"\" if none)\n"
                    "- situation: caller's own words describing their distress\n"
                    "- emergency_type: one of: cardiac arrest, fire, structural collapse, "
                    "flooding, car accident, shooting, stabbing, medical, unknown\n"
                    "- injuries: injury description or \"none\"\n"
                    "- hazards: active dangers or \"none\"\n"
                    "- mobility: \"mobile\", \"trapped\", \"unable to move\", or \"limited mobility\"\n"
                    "- num_people: integer (default 1)\n\n"
                    "Return ONLY valid JSON.\n\nTranscript:\n" + formatted
                )
            }]
        )
        text = msg.content[0].text.strip()
        if text.startswith("```"):
            text = re.sub(r'^```(?:json)?\s*\n?', '', text)
            text = re.sub(r'\n?\s*```$', '', text)
        return json.loads(text)
    except Exception as e:
        print(f"[extract_claude] error: {e}, falling back to regex")
        return extract_from_transcript(transcript_raw)


# ── Transcript keyword extraction (regex fallback) ────────────────────────────
EMERGENCY_KEYWORDS = {
    "cardiac arrest":      ["cardiac arrest", "heart attack", "not breathing", "stopped breathing", "chest pain"],
    "fire":                ["fire", "burning", "flames", "smoke", "on fire"],
    "structural collapse": ["collapse", "collapsed", "building fell", "ceiling fell", "roof caved"],
    "flooding":            ["flood", "flooding", "water rising", "underwater", "swept away"],
    "car accident":        ["car accident", "crash", "collision", "hit by a car", "car crash", "vehicle"],
    "shooting":            ["shot", "shooting", "gunshot", "gun", "fired at"],
    "stabbing":            ["stabbed", "stabbing", "knife", "cut with"],
    "medical":             ["injured", "hurt", "pain", "bleeding", "unconscious", "passed out", "fell down"],
}
INJURY_KEYWORDS   = ["unconscious", "not breathing", "heavy bleeding", "severe", "broken", "bleeding", "cuts", "passed out"]
HAZARD_KEYWORDS   = ["fire spreading", "gas leak", "weapons", "rising water", "debris", "power line", "downed line"]
MOBILITY_KEYWORDS = ["trapped", "unable to move", "cannot move", "immobile", "can't move", "stuck"]
LOCATION_PATTERNS = [
    r'\b\d+\s+\w[\w\s]{2,30}?(?:street|st|avenue|ave|boulevard|blvd|road|rd|drive|dr|lane|ln|way|court|ct|place|pl|highway|hwy)\b',
    r'\b(?:corner of|intersection of)\s+[\w\s]+\s+and\s+[\w\s,]+',
    r'\b(?:near|at|on)\s+[\w\s,]{5,50}?(?:street|st|avenue|ave|boulevard|blvd|road|rd|drive|dr|lane|ln|way)\b',
    r'\b\w[\w\s]{2,30},\s*[A-Z][a-zA-Z\s]{2,20}(?:,\s*[A-Z]{2})?\b',
]

def extract_from_transcript(transcript_raw) -> dict:
    """Regex-based extraction. Accepts list of message dicts or plain string."""
    situation, full_text = _flatten_transcript(transcript_raw)
    text = full_text.lower()

    emergency_type = "unknown"
    for etype, keywords in EMERGENCY_KEYWORDS.items():
        if any(kw in text for kw in keywords):
            emergency_type = etype
            break

    location = None
    for pattern in LOCATION_PATTERNS:
        m = re.search(pattern, full_text, re.IGNORECASE)
        if m:
            location = m.group().strip()
            break
    if not location:
        road_words = ["street", "avenue", "blvd", "boulevard", "drive", "road", "lane", "way", "near", "at the", "on the"]
        for sentence in re.split(r'[.!?,]', full_text):
            if any(w in sentence.lower() for w in road_words):
                location = sentence.strip()
                break

    injuries = next((kw for kw in INJURY_KEYWORDS if kw in text), "none")
    hazards  = next((kw for kw in HAZARD_KEYWORDS  if kw in text), "none")
    mobility = "mobile"
    for kw in MOBILITY_KEYWORDS:
        if kw in text:
            mobility = kw
            break

    num_people = 1
    m = re.search(r'(\d+)\s*(?:people|persons?|injured|victims?|individuals?)', text)
    if m:
        num_people = int(m.group(1))
    else:
        for word, val in WORD_TO_INT.items():
            if re.search(rf'\b{word}\s+(?:people|persons?|injured)', text):
                num_people = val
                break

    caller_name = "Unknown"
    m = re.search(r"(?:my name is|this is|i'm|i am)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)", full_text)
    if m:
        caller_name = m.group(1)

    return {
        "caller_name":    caller_name,
        "location":       location or "",
        "situation":      situation,
        "emergency_type": emergency_type,
        "num_people":     num_people,
        "injuries":       injuries,
        "hazards":        hazards,
        "mobility":       mobility,
    }


# ── Read endpoints ────────────────────────────────────────────────────────────
def _active_sorted_serialized() -> list[dict]:
    items = [i for i in incidents.values() if i["status"] == "active"]
    for inc in items:
        update_incident_aggregates(inc)  # refresh time-decay etc.
    items.sort(key=lambda i: i["score"], reverse=True)
    return [serialize_incident(i) for i in items]


@app.get("/incidents")
def list_incidents(include_resolved: bool = False):
    if include_resolved:
        items = list(incidents.values())
        for inc in items:
            update_incident_aggregates(inc)
        items.sort(key=lambda i: i["score"], reverse=True)
        return [serialize_incident(i) for i in items]
    return _active_sorted_serialized()


@app.get("/incidents/stream")
async def stream_incidents():
    async def event_generator():
        last_sent = None
        while True:
            payload = json.dumps(_active_sorted_serialized())
            if payload != last_sent:
                last_sent = payload
                yield f"data: {payload}\n\n"
            await asyncio.sleep(1)

    return StreamingResponse(event_generator(), media_type="text/event-stream")


@app.delete("/incidents/{incident_id}", status_code=200)
async def resolve_incident(incident_id: str):
    inc = incidents.pop(incident_id, None)
    if not inc:
        raise HTTPException(status_code=404, detail="Incident not found")
    for cid in inc.get("call_ids", []):
        calls.pop(cid, None)
    await db.delete_incident(incident_id)
    return {"detail": f"Incident {incident_id} resolved."}


@app.get("/stations/nearest")
async def nearest_station(lat: float, lng: float, type: str):
    """Closest dispatchable station of `type` (fire | ems | police | rescue) to (lat,lng)."""
    station = await stations.find_nearest_station(lat, lng, type)
    if station is None:
        raise HTTPException(status_code=404, detail=f"no '{type}' station found near ({lat},{lng})")
    return station

