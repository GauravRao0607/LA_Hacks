import asyncio
import json
import math
import os
import re
import uuid
from datetime import datetime
from typing import Any, Optional

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

app = FastAPI(title="CrisisLine AI Backend")

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


def extract_params_from_conversation_history(body: dict) -> dict | None:
    """
    When the tool call 404s, ElevenLabs still sends a post_call_transcription
    webhook containing the attempted tool params in system__conversation_history.
    Pull them out so we don't lose the call.
    """
    try:
        data = body.get("data", {})
        client_data = data.get("conversation_initiation_client_data", {})
        extra = client_data.get("custom_llm_extra_body", {})
        history_raw = extra.get("system__conversation_history", "")
        if not history_raw:
            return None
        entries = json.loads(history_raw).get("entries", [])
        for entry in reversed(entries):
            if entry.get("role") == "agent" and "tool_requests" in entry:
                for req in entry["tool_requests"]:
                    params = json.loads(req.get("params_as_json") or "{}")
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


# ── Per-call urgency (with non-linear interactions) ───────────────────────────
def score_call(payload: CallPayload) -> tuple[int, str]:
    score = 0
    etype = payload.emergency_type.lower()

    HIGH = ["cardiac arrest", "fire", "structural collapse", "shooting", "stabbing"]
    MEDIUM = ["flooding", "car accident"]

    if any(e in etype for e in HIGH):
        score += 30
    elif any(e in etype for e in MEDIUM):
        score += 20
    else:
        score += 5

    injuries = (payload.injuries or "").lower()
    severe_injury = "unconscious" in injuries or "not breathing" in injuries
    if severe_injury:
        score += 25
    elif "heavy bleeding" in injuries or "severe" in injuries:
        score += 20
    elif injuries and injuries not in ("none", "no", "n/a"):
        score += 10

    hazards = (payload.hazards or "").lower()
    hazard_hits = sum(1 for h in CRITICAL_HAZARDS if h in hazards)
    score += hazard_hits * 10
    if hazards and hazards not in ("none", "no", "n/a") and hazard_hits == 0:
        score += 5

    mobility = (payload.mobility or "").lower()
    trapped = any(k in mobility for k in ("trapped", "unable to move", "cannot move", "immobile"))
    if trapped:
        score += 15

    n = payload.num_people or 1
    if n >= 10:
        score += 15
    elif n >= 6:
        score += 10
    elif n >= 3:
        score += 5

    # Non-linear interactions
    if "fire" in etype and n >= 3:
        score = int(score * 1.25)
    if trapped and hazard_hits > 0:
        score += 10
    if severe_injury and n >= 3:
        score += 10

    score = min(100, max(0, score))
    if score >= 75:
        tier = "Critical"
    elif score >= 40:
        tier = "Urgent"
    else:
        tier = "Standard"
    return score, tier


# ── Aggregate incident scoring ────────────────────────────────────────────────
def score_incident(incident: dict) -> tuple[int, str]:
    icalls = [calls[cid] for cid in incident["call_ids"] if cid in calls]
    if not icalls:
        return 0, "Standard"

    severities = [c["call_score"] for c in icalls]
    max_sev = max(severities)
    avg_sev = sum(severities) / len(severities)
    n = len(icalls)

    unique_hazards: set[str] = set()
    for c in icalls:
        h = (c["hazards"] or "").lower()
        for tok in CRITICAL_HAZARDS:
            if tok in h:
                unique_hazards.add(tok)

    age_s = (datetime.utcnow() - datetime.fromisoformat(incident["created_at"])).total_seconds()
    age_min = age_s / 60
    time_bonus = min(TIME_DECAY_CAP, age_min * TIME_DECAY_SLOPE)

    score = (
        max_sev
        + 0.3 * avg_sev
        + 8 * math.log2(n + 1)
        + 4 * len(unique_hazards)
        + time_bonus
    )
    score = int(min(100, max(0, score)))

    if score >= 75:
        tier = "Critical"
    elif score >= 40:
        tier = "Urgent"
    else:
        tier = "Standard"
    return score, tier


# ── Resource allocation ───────────────────────────────────────────────────────
def required_responders(incident: dict) -> dict[str, int]:
    icalls = [calls[cid] for cid in incident["call_ids"] if cid in calls]
    n = len(icalls)
    family = incident["family"]

    # Baseline mix per family (1-2 calls)
    base = {
        "fire_complex": {"fire": 1, "ems": 1, "police": 0, "rescue": 1},
        "medical":      {"fire": 0, "ems": 1, "police": 0, "rescue": 0},
        "violence":     {"fire": 0, "ems": 1, "police": 2, "rescue": 0},
        "water":        {"fire": 0, "ems": 1, "police": 0, "rescue": 1},
        "traffic":      {"fire": 1, "ems": 1, "police": 1, "rescue": 0},
    }.get(family, {"fire": 0, "ems": 1, "police": 1, "rescue": 0})

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
        for k, v in {"fire": 4, "ems": 4, "police": 2, "rescue": 2}.items():
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


# ── Call building & clustering ────────────────────────────────────────────────
async def build_call(raw: dict, lat: float | None = None, lng: float | None = None) -> dict:
    normalized = normalize_payload(raw)
    payload = CallPayload(**normalized)
    if lat is None or lng is None:
        lat, lng = await geocode(payload.location)
    score, tier = score_call(payload)
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
    recompute_centroid(incident)
    icalls = [calls[cid] for cid in incident["call_ids"] if cid in calls]
    if icalls:
        top = max(icalls, key=lambda c: c["call_score"])
        incident["primary_emergency_type"] = top["emergency_type"]
        incident["location_label"] = top["location"]
    score, tier = score_incident(incident)
    incident["score"] = score
    incident["tier"] = tier
    incident["required_responders"] = required_responders(incident)
    incident["updated_at"] = datetime.utcnow().isoformat()


def create_incident_for_call(call: dict) -> dict:
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
        "score":                  0,
        "tier":                   "Standard",
        "required_responders":    {},
        "created_at":             now,
        "updated_at":             now,
        "status":                 "active",
    }
    incidents[iid] = incident
    call["incident_id"] = iid
    update_incident_aggregates(incident)
    return incident


def merge_call_into_incident(call: dict, incident_id: str) -> dict:
    incident = incidents[incident_id]
    incident["call_ids"].append(call["id"])
    call["incident_id"] = incident_id
    update_incident_aggregates(incident)
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

    # post_call_transcription = tool call failed (404 on our end).
    # Recover the params ElevenLabs already extracted from the conversation.
    if body.get("type") == "post_call_transcription":
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
        incident = merge_call_into_incident(call, match)
    else:
        incident = create_incident_for_call(call)
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
                incident = merge_call_into_incident(call, match)
            else:
                incident = create_incident_for_call(call)
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
def resolve_incident(incident_id: str):
    inc = incidents.get(incident_id)
    if not inc:
        raise HTTPException(status_code=404, detail="Incident not found")
    inc["status"] = "resolved"
    inc["updated_at"] = datetime.utcnow().isoformat()
    return {"detail": f"Incident {incident_id} resolved."}

