import asyncio
import json
import os
import re
import uuid
import random
from datetime import datetime
from typing import Any, Optional

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from dotenv import load_dotenv

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

# ── In-memory store ───────────────────────────────────────────────────────────
incidents: list[dict] = []

# ── Schemas ───────────────────────────────────────────────────────────────────
class CallPayload(BaseModel):
    caller_name: str
    location: str
    emergency_type: Optional[str] = "unknown"
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
        "num_people":     normalize_num_people(raw.get("num_people")),
        "injuries":       normalize_str(raw.get("injuries"), "none"),
        "hazards":        normalize_str(raw.get("hazards"), "none"),
        "mobility":       normalize_str(raw.get("mobility"), "mobile"),
        "timestamp":      raw.get("timestamp"),
    }


# ── ElevenLabs payload extraction ─────────────────────────────────────────────
def extract_elevenlabs_params(body: dict) -> dict:
    # ElevenLabs custom tool: { "parameters": { ... } }
    if "parameters" in body and isinstance(body["parameters"], dict):
        return body["parameters"]
    # Nested: { "tool_call": { "parameters": { ... } } }
    if "tool_call" in body and isinstance(body.get("tool_call"), dict):
        tc = body["tool_call"]
        if "parameters" in tc:
            return tc["parameters"]
    # Direct JSON — already flat
    return body


# ── Urgency scoring ───────────────────────────────────────────────────────────
def score_incident(payload: CallPayload) -> tuple[int, str]:
    score = 0

    etype = payload.emergency_type.lower()
    HIGH = ["cardiac arrest", "fire", "structural collapse"]
    MEDIUM = ["flooding", "car accident"]

    if any(e in etype for e in HIGH):
        score += 30
    elif any(e in etype for e in MEDIUM):
        score += 20
    else:
        score += 5

    injuries = (payload.injuries or "").lower()
    if "unconscious" in injuries or "not breathing" in injuries:
        score += 25
    elif "heavy bleeding" in injuries or "severe" in injuries:
        score += 20
    elif injuries and injuries not in ("none", "no", "n/a"):
        score += 10

    hazards = (payload.hazards or "").lower()
    CRITICAL_HAZARDS = ["fire spreading", "gas leak", "weapons", "rising water"]
    hazard_hits = sum(1 for h in CRITICAL_HAZARDS if h in hazards)
    score += hazard_hits * 10
    if hazards and hazards not in ("none", "no", "n/a") and hazard_hits == 0:
        score += 5

    mobility = (payload.mobility or "").lower()
    if any(k in mobility for k in ("trapped", "unable to move", "cannot move", "immobile")):
        score += 15

    n = payload.num_people or 1
    if n >= 10:
        score += 15
    elif n >= 6:
        score += 10
    elif n >= 3:
        score += 5

    score = min(score, 100)

    if score >= 70:
        tier = "Critical"
    elif score >= 40:
        tier = "Urgent"
    else:
        tier = "Standard"

    return score, tier


# ── Geocoding ─────────────────────────────────────────────────────────────────
async def geocode(address: str) -> tuple[float | None, float | None]:
    token = os.getenv("MAPBOX_ACCESS_TOKEN")
    if not token:
        return None, None

    url = "https://api.mapbox.com/search/geocode/v6/forward"
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(url, params={"q": address, "access_token": token})
        resp.raise_for_status()
        data = resp.json()

    features = data.get("features", [])
    if not features:
        return None, None

    coords = features[0]["geometry"]["coordinates"]
    return coords[1], coords[0]  # lat, lng


# ── Incident builder (shared) ─────────────────────────────────────────────────
async def build_incident(raw: dict) -> dict:
    normalized = normalize_payload(raw)
    payload = CallPayload(**normalized)
    lat, lng = await geocode(payload.location)
    score, tier = score_incident(payload)
    return {
        "id":             str(uuid.uuid4()),
        "caller_name":    payload.caller_name,
        "location":       payload.location,
        "lat":            lat,
        "lng":            lng,
        "emergency_type": payload.emergency_type,
        "num_people":     payload.num_people,
        "injuries":       payload.injuries,
        "hazards":        payload.hazards,
        "mobility":       payload.mobility,
        "score":          score,
        "tier":           tier,
        "timestamp":      payload.timestamp or datetime.utcnow().isoformat(),
    }


# ── GET / (health check) ──────────────────────────────────────────────────────
@app.get("/")
def health_check():
    return {"status": "ok", "active_incidents": len(incidents)}


# ── POST /webhook/call ────────────────────────────────────────────────────────
@app.post("/webhook/call", status_code=201)
async def receive_call(request: Request):
    body = await request.json()
    params = extract_elevenlabs_params(body)
    incident = await build_incident(params)
    incidents.append(incident)
    return incident


# ── POST /webhook/call-end ────────────────────────────────────────────────────
@app.post("/webhook/call-end", status_code=200)
async def call_end(request: Request):
    body = await request.json()
    print(f"\n[call-end] {json.dumps(body, indent=2)}")

    # If a tool call already fired during the call, an incident was created
    # via /webhook/call within the last 10 minutes — don't double-create.
    recent_cutoff = datetime.utcnow().timestamp() - 600
    tool_fired = any(
        datetime.fromisoformat(inc["timestamp"]).timestamp() > recent_cutoff
        for inc in incidents
    )

    if not tool_fired:
        transcript_raw = body.get("transcript", "")
        if isinstance(transcript_raw, list):
            transcript = " ".join(
                m.get("message", m.get("text", "")) for m in transcript_raw
            )
        else:
            transcript = str(transcript_raw)

        extracted = extract_from_transcript(transcript)
        if extracted.get("location"):
            incident = await build_incident(extracted)
            incidents.append(incident)
            print(f"[call-end] fallback incident created: {incident['id']}")
            return {"detail": "fallback incident created", "incident": incident}
        else:
            print("[call-end] no location found in transcript, skipping")

    return {"detail": "ok"}


# ── Transcript keyword extraction (fallback) ──────────────────────────────────
EMERGENCY_KEYWORDS = {
    "cardiac arrest":      ["cardiac arrest", "heart attack", "not breathing", "stopped breathing"],
    "fire":                ["fire", "burning", "flames", "smoke"],
    "structural collapse": ["collapse", "collapsed", "building fell"],
    "flooding":            ["flood", "flooding", "water rising"],
    "car accident":        ["car accident", "crash", "collision", "hit by a car"],
    "shooting":            ["shot", "shooting", "gunshot"],
    "stabbing":            ["stabbed", "stabbing", "knife"],
    "medical":             ["injured", "hurt", "pain", "bleeding", "unconscious"],
}

INJURY_KEYWORDS   = ["unconscious", "not breathing", "heavy bleeding", "severe", "broken", "bleeding", "cuts"]
HAZARD_KEYWORDS   = ["fire spreading", "gas leak", "weapons", "rising water", "debris"]
MOBILITY_KEYWORDS = ["trapped", "unable to move", "cannot move", "immobile"]

LOCATION_PATTERNS = [
    r'\b\d+\s+\w[\w\s]+?(?:street|st|avenue|ave|boulevard|blvd|road|rd|drive|dr|lane|ln|way|court|ct|place|pl)\b',
    r'\b(?:near|at|on|corner of|intersection of)\s+[\w\s,]+',
    r'\b\w[\w\s]+,\s*(?:los angeles|la|inglewood|santa monica|compton|torrance|pasadena)\b',
]

def extract_from_transcript(transcript: str) -> dict:
    text = transcript.lower()

    emergency_type = "unknown"
    for etype, keywords in EMERGENCY_KEYWORDS.items():
        if any(kw in text for kw in keywords):
            emergency_type = etype
            break

    location = None
    for pattern in LOCATION_PATTERNS:
        m = re.search(pattern, transcript, re.IGNORECASE)
        if m:
            location = m.group().strip()
            break
    if not location:
        for sentence in re.split(r'[.!?]', transcript):
            if any(w in sentence.lower() for w in ["street", "avenue", "blvd", "near", "at the", "on the"]):
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
    m = re.search(r"(?:my name is|this is|i'm|i am)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)", transcript)
    if m:
        caller_name = m.group(1)

    return {
        "caller_name":    caller_name,
        "location":       location or "",
        "emergency_type": emergency_type,
        "num_people":     num_people,
        "injuries":       injuries,
        "hazards":        hazards,
        "mobility":       mobility,
    }


# ── GET /incidents ────────────────────────────────────────────────────────────
@app.get("/incidents")
def list_incidents():
    return sorted(incidents, key=lambda x: x["score"], reverse=True)


# ── GET /incidents/stream (SSE) ───────────────────────────────────────────────
@app.get("/incidents/stream")
async def stream_incidents():
    async def event_generator():
        last_sent = None
        while True:
            current = sorted(incidents, key=lambda x: x["score"], reverse=True)
            payload = json.dumps(current)
            if payload != last_sent:
                last_sent = payload
                yield f"data: {payload}\n\n"
            await asyncio.sleep(1)

    return StreamingResponse(event_generator(), media_type="text/event-stream")


# ── DELETE /incidents/{id} ────────────────────────────────────────────────────
@app.delete("/incidents/{incident_id}", status_code=200)
def resolve_incident(incident_id: str):
    for i, inc in enumerate(incidents):
        if inc["id"] == incident_id:
            incidents.pop(i)
            return {"detail": f"Incident {incident_id} resolved."}
    raise HTTPException(status_code=404, detail="Incident not found")


# ── POST /incidents/mock ──────────────────────────────────────────────────────
MOCK_LA_ADDRESSES = {
    "1600 Vine St, Los Angeles, CA 90028":          (34.0983, -118.3268),
    "350 S Grand Ave, Los Angeles, CA 90071":        (34.0523, -118.2579),
    "6801 Hollywood Blvd, Los Angeles, CA 90028":    (34.1016, -118.3403),
    "11000 Kinross Ave, Los Angeles, CA 90024":      (34.0611, -118.4468),
    "3900 W Manchester Blvd, Inglewood, CA 90305":   (33.9581, -118.3694),
    "2900 Los Feliz Blvd, Los Angeles, CA 90039":    (34.1019, -118.2813),
    "5900 Wilshire Blvd, Los Angeles, CA 90036":     (34.0626, -118.3524),
    "801 S Figueroa St, Los Angeles, CA 90017":      (34.0467, -118.2618),
    "4100 W Sunset Blvd, Los Angeles, CA 90029":     (34.0868, -118.2966),
    "1 World Way, Los Angeles, CA 90045":            (33.9425, -118.4081),
}

MOCK_EMERGENCY_TYPES = [
    "cardiac arrest", "fire", "structural collapse",
    "flooding", "car accident",
    "noise complaint", "minor injury",
]
MOCK_INJURIES  = ["unconscious", "not breathing", "heavy bleeding", "broken arm", "minor cuts", "none"]
MOCK_HAZARDS   = ["fire spreading", "gas leak", "weapons", "rising water", "debris on road", "none"]
MOCK_MOBILITY  = ["trapped", "unable to move", "mobile", "limited mobility"]


@app.post("/incidents/mock", status_code=201)
async def mock_incident():
    address = random.choice(list(MOCK_LA_ADDRESSES.keys()))
    payload = CallPayload(
        caller_name=f"Caller_{random.randint(100, 999)}",
        location=address,
        emergency_type=random.choice(MOCK_EMERGENCY_TYPES),
        num_people=random.randint(1, 15),
        injuries=random.choice(MOCK_INJURIES),
        hazards=random.choice(MOCK_HAZARDS),
        mobility=random.choice(MOCK_MOBILITY),
        timestamp=datetime.utcnow().isoformat(),
    )

    lat, lng = MOCK_LA_ADDRESSES[address]
    score, tier = score_incident(payload)

    incident = {
        "id":             str(uuid.uuid4()),
        "caller_name":    payload.caller_name,
        "location":       payload.location,
        "lat":            lat,
        "lng":            lng,
        "emergency_type": payload.emergency_type,
        "num_people":     payload.num_people,
        "injuries":       payload.injuries,
        "hazards":        payload.hazards,
        "mobility":       payload.mobility,
        "score":          score,
        "tier":           tier,
        "timestamp":      payload.timestamp,
    }

    incidents.append(incident)
    return incident
