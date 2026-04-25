# CrisisLine AI — Project Documentation

## What This Is

CrisisLine AI is a real-time emergency dispatch triage system. An AI voice agent (built on ElevenLabs) answers 911-style calls, extracts structured emergency data, and sends it to this backend. The backend geocodes the location, scores the urgency, clusters nearby calls of the same type into incidents, and streams live updates to a React dashboard where human dispatchers can monitor and prioritize response.

---

## Architecture

```
Caller → ElevenLabs Voice Agent (JP)
              ↓  POST /webhook/call
         FastAPI Backend (port 8001)
              ↓  geocode address
           Mapbox API
              ↓  SSE stream
         React Frontend (port 5180)
```

**Tunneling:**
- `ngrok` exposes the backend publicly so ElevenLabs can reach it via webhook
- `cloudflared` exposes the frontend publicly for sharing
- Run `./start.sh` to start everything. Run `./stop.sh` to stop.

---

## Environment Variables

**`backend/.env`**
```
GOOGLE_PLACES_API_KEY=     # primary geocoder — Google Places Text Search (New)
MAPBOX_ACCESS_TOKEN=       # fallback geocoder
ELEVENLABS_WEBHOOK_SECRET= # from ElevenLabs dashboard
ANTHROPIC_API_KEY=         # optional — enables Claude address correction + smarter transcript parsing
MLH_CODE=                  # hackathon code
```

**`frontend/.env`**
```
VITE_MAPBOX_TOKEN=         # for rendering the map (can be the same token as backend)
VITE_API_URL=              # URL of the backend (ngrok public URL or http://localhost:8001)
```

---

## Backend (`backend/main.py`)

FastAPI app. All data is in-memory (restarts wipe it).

### Data Model

**Call** — one phone call from one person:
```
id, caller_name, location, lat, lng,
emergency_type, situation, num_people,
injuries, hazards, mobility,
call_score (0–100), call_tier, timestamp
```

**Incident** — one or more calls clustered together:
```
id, call_ids[], family, centroid_lat, centroid_lng,
primary_emergency_type, location_label,
score (0–100), tier (Critical/Urgent/Standard),
required_responders {fire, ems, police, rescue},
created_at, updated_at, status (active/resolved)
```

### Key Constants
| Constant | Value | Meaning |
|---|---|---|
| `CLUSTER_RADIUS_M` | 300m | Calls within this distance cluster into one incident |
| `CLUSTER_WINDOW_S` | 30 min | Calls only cluster with incidents updated in this window |
| `TIME_DECAY_SLOPE` | 0.4 | Urgency points added per minute an incident ages |
| `TIME_DECAY_CAP` | 20 | Max time-decay bonus |

### Emergency Families
Calls only cluster with other calls of the same family:
- `fire_complex` — fire, structural collapse
- `medical` — cardiac arrest, medical
- `violence` — shooting, stabbing
- `water` — flooding
- `traffic` — car accident
- Anything else is its own family

### Scoring

**Call score** (`score_call`): 0–100 based on emergency type, injuries, hazards, mobility, number of people, and non-linear interaction bonuses (e.g. fire + multiple people multiplies score).

**Incident score** (`score_incident`): combines max severity of all calls, average severity, log-scaled call volume, unique critical hazards, and a time-decay bonus that grows the longer an incident waits.

**Tiers:**
- `Critical` — score ≥ 75
- `Urgent` — score ≥ 40
- `Standard` — below 40

### Address Resolution (`resolve_address`)
Wraps two pipelines and returns `(lat, lng, canonical_address)`. The canonical address (when available) replaces the raw spoken transcript on the call so the map and sidebar show the corrected version.

**Strategy 1 — Google Places Text Search (primary)** (`_google_places_resolve`)
Single round-trip to `places.googleapis.com/v1/places:searchText` with the spoken text as `textQuery`, biased to a 50 km circle around downtown LA. Returns coordinates **and** a canonical `formattedAddress` in one call. Designed to handle:
- Filler words ("near the music center")
- Spelled-out numbers ("three fifty south grand")
- STT mishearings (e.g. "Denev Drive" → "De Neve Dr" at UCLA)

Requires `GOOGLE_PLACES_API_KEY`. Free Google Cloud credit ($200/mo) covers all hackathon-scale usage.

**Strategy 2 — Mapbox fallback** (`geocode`), tried only if Google returns no result:
1. Mapbox Geocoding v6 — direct query
2. Mapbox Search Box Suggest — fuzzy matching
3. Strip house number — retry with just the street name
4. Claude correction — only if `ANTHROPIC_API_KEY` is set; asks Claude to correct a misheard address then retries Mapbox v6

> **Important**: Backend uses `print(...)` for resolution logs. `main.py` calls `sys.stdout.reconfigure(line_buffering=True)` at startup so prints flush to `/tmp/lah-logs/backend.log` immediately. Without that line, `nohup`-redirected stdout block-buffers and you'd see no `[google]` / `[geocode/...]` log lines.

### Webhook Handling (`receive_call`)
Handles two types of bodies on `POST /webhook/call`:

1. **Direct tool call** — ElevenLabs fires `submit_emergency_report` tool, params arrive as `{"parameters": {...}}`. Processed immediately.
2. **`post_call_transcription`** — sent by ElevenLabs at call end. This fires when the direct tool call failed (e.g. URL misconfiguration). The backend recovers the tool params from `system__conversation_history` in the body. Falls back to transcript extraction if params aren't there.

> **Known issue:** The ElevenLabs tool URL must not have a trailing space. `POST /webhook/call ` (with space) returns 404. Fix in ElevenLabs tool config.

### Transcript Extraction
Two-tier fallback for when the tool doesn't fire and only a raw transcript is available:
1. **Claude** (`extract_from_transcript_with_claude`) — if `ANTHROPIC_API_KEY` is set, sends the formatted transcript to Claude Haiku and gets back structured JSON
2. **Regex** (`extract_from_transcript`) — keyword matching for emergency type, location patterns, injuries, hazards, mobility, num_people, caller name. Also pulls `situation` from the caller's first utterance.

### API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | Health check |
| `POST` | `/webhook/call` | Receive call from ElevenLabs (tool call or post_call_transcription) |
| `POST` | `/webhook/call-end` | Alternative call-end webhook |
| `GET` | `/incidents` | List all active incidents (sorted by score desc) |
| `GET` | `/incidents/stream` | SSE stream — pushes incident list every second when data changes |
| `DELETE` | `/incidents/{id}` | Resolve an incident |

---

## Frontend (`frontend/src/`)

React + Vite app. Connects to the backend SSE stream and renders live.

### `hooks/useIncidents.js`
Core data hook. Opens an SSE connection to `/incidents/stream` and keeps a live list of incidents in state. Adapts raw backend data into frontend-friendly shape — maps `emergency_type` to display category (`Medical`, `Rescue`, `Structural`, etc.), computes `timeAgo`, pulls `situation` from the highest-scored call, aggregates `people` count.

### `components/Map.jsx`
Mapbox GL map. Renders a colored circle marker for each incident at `centroid_lat/lng`. Color = tier color. Clicking a marker selects that incident.

### `components/Sidebar.jsx`
Scrollable list of active incidents sorted by score. Each card shows tier badge, type, address, time ago, call count. Clicking selects an incident.

### `components/TopBar.jsx`
Live header bar. Shows system name, current time, and real counts from the live incident stream — total active incidents, critical count, urgent count.

### `components/IncidentDetail.jsx`
Slide-in detail panel for a selected incident. Shows:
- Emergency type + tier badge
- Caller's situation quote (first utterance)
- Location, time reported, people count, clustered call count
- Priority score bar
- Required responders breakdown (fire/EMS/police/rescue units)
- Resolve button (calls `DELETE /incidents/{id}`)

### `data/constants.js`
Shared color constants: `TIER_COLORS` and `TIER_RGB` keyed by `Critical / Urgent / Standard`.

---

## ElevenLabs Agent (JP)

The voice agent is named JP. Key behaviors:
- Lets the caller speak first — captures `situation` from their opening statement
- Collects: `situation → caller_name → location (with city) → emergency_type → injuries → hazards → mobility`
- Only asks `num_people` if the situation is clearly Critical (fire in a building, collapse, mass casualty)
- If address has no city, always follows up: "And what city is that in?"
- Repeats address back to caller to confirm before submitting
- Calls the `submit_emergency_report` tool (points to `POST /webhook/call` on ngrok) with fields: `caller_name, location, emergency_type, situation, num_people, injuries, hazards, mobility`

---

## Running Locally

```bash
# First time only
./install.sh

# Every time
./start.sh   # starts backend, frontend, ngrok, cloudflared
./stop.sh    # stops everything
```

Logs: `/tmp/lah-logs/backend.log`, `frontend.log`, `ngrok.log`, `cloudflared.log`
