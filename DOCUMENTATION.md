# CrisisLine AI — Project Documentation

## What This Is

CrisisLine AI is a real-time emergency dispatch triage system. An AI voice agent (built on ElevenLabs) answers 911-style calls, extracts structured emergency data, and sends it to this backend. The backend resolves the address, scores the urgency with an LLM, clusters nearby calls of the same type into incidents, persists everything to Postgres (Supabase), and streams live updates to a React dashboard. From the dashboard a human dispatcher can route the closest real police / fire / EMS / rescue units to the scene.

---

## Architecture

```
Caller ─→ ElevenLabs Voice Agent (JP)
              │  POST /webhook/call (tool call + post-call transcription)
              ▼
        FastAPI Backend (port 8001)
        ├─ Address      → Google Places Text Search (canonical) → Mapbox fallback
        ├─ Clustering   → haversine + same emergency-family + 30-min window
        ├─ Scoring      → Google AI Studio (Gemini 2.5 Flash) — full incident → score+tier
        ├─ Dispatch     → Google Places Nearby Search — closest real station per type
        └─ Persistence  → Supabase (asyncpg, JSONB) — hydrate on startup
              │  SSE stream
              ▼
        React Frontend (port 5180)
        ├─ Live queue & priority sorting
        ├─ Mapbox map with incident markers, dispatched-vehicle animation, station origins
        ├─ Knowledge graph view of clustered incidents
        └─ Dispatch / Resolve actions
```

**Tunneling for live ElevenLabs / sharing:**
- `ngrok` exposes the backend (uses your reserved free domain, stable URL).
- `cloudflared` exposes the frontend (random `*.trycloudflare.com` URL each restart).
- `./start.sh` brings everything up; `./stop.sh` tears it down.

---

## Environment Variables

**`backend/.env`**
```
SUPABASE_DB_URL=           # Postgres URI from Supabase → Settings → Database → Transaction pooler (port 6543)
GOOGLE_AI_API_KEY=         # Gemini 2.5 Flash for incident urgency scoring
GOOGLE_PLACES_API_KEY=     # Places Text Search (geocoding) + Places Nearby Search (stations)
MAPBOX_ACCESS_TOKEN=       # geocoding fallback when Google fails
ELEVENLABS_WEBHOOK_SECRET= # from ElevenLabs dashboard (currently stored, not yet enforced)
ANTHROPIC_API_KEY=         # optional — Claude transcript extraction + address correction
MLH_CODE=                  # hackathon perk code
```

**`frontend/.env`**
```
VITE_MAPBOX_TOKEN=         # client-side map rendering (can reuse the backend Mapbox token)
VITE_API_URL=              # public backend URL (ngrok) or http://localhost:8001
```

Both `.env` files are gitignored. `uvicorn --reload` reloads on `.py` changes only — restart the backend after editing `.env`.

---

## Backend (`backend/`)

FastAPI app split across four modules:

| File | Role |
|---|---|
| `main.py` | FastAPI app, request handlers, in-memory state, address resolution, clustering, transcript handling |
| `db.py` | Supabase persistence (asyncpg pool, hydrate on startup, mirrored writes) |
| `scoring.py` | Incident urgency scoring (Gemini-backed; rule-based fallback preserved as comments) |
| `stations.py` | Closest real-world station lookup via Google Places Nearby Search |

### Data Model

**Call** — one phone call from one person:
```
id, incident_id, caller_name, location, lat, lng,
emergency_type, situation, num_people,
injuries, hazards, mobility, timestamp,
call_score (always 0; Gemini scores at incident level only),
call_tier
```

**Incident** — one or more clustered calls:
```
id, call_ids[], family,
centroid_lat, centroid_lng, primary_emergency_type, location_label,
score (0–100), tier (Critical/Urgent/Standard),
required_responders {fire, ems, police, rescue},
created_at, updated_at, status (only "active" — resolved incidents are hard-deleted)
```

**Runtime store** — two in-memory dicts in `main.py` (`calls` and `incidents`) are the source of truth at runtime. Postgres is the durability backstop: writes go to both; on startup `db.hydrate()` rebuilds the dicts from the DB.

### Supabase Persistence (`db.py`)

- **Driver:** `asyncpg` (direct Postgres, faster than the Supabase REST client).
- **Connection:** uses Supabase's **transaction pooler** (port 6543, user `postgres.<project_ref>`). `statement_cache_size=0` is required because pgbouncer transaction-mode disallows server-side prepared statements.
- **JSONB codec:** `set_type_codec("jsonb", encoder=json.dumps, decoder=json.loads)` — lets us pass dicts directly instead of dumping/loading at every call site.
- **Schema:**
  ```sql
  create table calls (
    id          text primary key,
    incident_id text,
    data        jsonb not null,
    created_at  timestamptz not null default now()
  );
  create table incidents (
    id         text primary key,
    status     text not null,
    score      int  not null default 0,
    data       jsonb not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );
  ```
- **When writes happen:** after every `create_incident_for_call`, `merge_call_into_incident`, and `resolve_incident`. Reads in `_active_sorted_serialized` do not write back (they only refresh `required_responders` / centroids in memory).
- **Resolve = hard delete:** `DELETE /incidents/{id}` removes the incident row and all its calls in a single transaction (`db.delete_incident`). The corresponding entries are also popped from the in-memory dicts.
- If `SUPABASE_DB_URL` is unset every `db.*` call is a no-op — the app still works as a stateless in-memory service.

### Scoring (`scoring.py`)

`scoring.score_incident_with_gemini(incident, icalls)` is the only path the runtime takes:

1. Builds a system prompt explaining the Critical / Urgent / Standard tiers and listing the factors (severity, hazards, people, mobility, age, cluster size).
2. Sends one POST to `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent` with a `responseSchema` forcing strict JSON output (`{score, tier, reasoning}`).
3. Returns `(score, tier)` — typically a 400–800 ms round-trip.
4. Falls back to `(50, "Urgent")` and logs the reason if `GOOGLE_AI_API_KEY` is missing or the request fails.

`score_call` still exists but always returns `(0, "Standard")` — per-call scoring is no longer used because the LLM gets the full call list at incident scoring time and handles it together. The original keyword-based rule scorers (`score_call` and `score_incident`) are preserved in `scoring.py` as a commented block — uncomment to revert.

### Address Resolution (`resolve_address` in `main.py`)

Returns `(lat, lng, canonical_address)`. The canonical address replaces the raw spoken transcript on the call so the map and sidebar show the corrected version.

**Strategy 1 — Google Places Text Search (primary)** (`_google_places_resolve`)
Single round-trip to `places.googleapis.com/v1/places:searchText` biased to a 50 km circle around downtown LA. Handles filler words ("near the music center"), spelled-out numbers ("three fifty south grand"), and STT mishearings ("Denev Drive" → "De Neve Dr" at UCLA). Requires `GOOGLE_PLACES_API_KEY`.

**Strategy 2 — Mapbox fallback** (`geocode`), tried only if Google returns no result:
1. Mapbox Geocoding v6 — direct query
2. Mapbox Search Box Suggest — fuzzy matching
3. Strip house number — retry with just the street name
4. Claude correction — only if `ANTHROPIC_API_KEY` is set; asks Claude to correct the misheard address and retries Mapbox v6

> **Logging note**: `main.py` calls `sys.stdout.reconfigure(line_buffering=True)` at startup. Without it, `nohup`-redirected stdout is block-buffered and you'd see no `[google]` / `[geocode/...]` / `[gemini]` log lines.

### Stations / Dispatch (`stations.py` + `GET /stations/nearest`)

`stations.find_nearest_station(lat, lng, unit_type)` calls Google **Places Nearby Search (New)** with `rankPreference: DISTANCE` and a 50 km radius. Internal type → Google place type:

| Internal | Google `includedTypes` |
|---|---|
| `fire` | `fire_station` |
| `police` | `police` |
| `ems` | `hospital` (ambulances dispatch from hospitals) |
| `rescue` | `fire_station` (rescue ops typically run by fire) |

Results are cached by rounded (lat, lng, type) so repeat dispatches in the same neighborhood don't burn API quota.

**Endpoint:** `GET /stations/nearest?lat=&lng=&type=`. The frontend's dispatch hook calls this once per required responder type when **Dispatch** is clicked.

### Clustering Rules

A new call merges into an existing **active** incident iff **all three**:
1. **Same emergency family** (`fire_complex`, `medical`, `violence`, `water`, `traffic` — anything else is its own family).
2. **Distance ≤ 300 m** from the incident centroid (haversine).
3. **Updated within the last 30 min**.

If multiple match, the closest wins. Centroid is recomputed as the mean of call coordinates on every merge. Constants live at the top of `main.py` (`CLUSTER_RADIUS_M`, `CLUSTER_WINDOW_S`).

### Webhook Handling (`receive_call`)

Single endpoint `POST /webhook/call` handles two body shapes:

1. **Live tool call** — `{"parameters": {...}}` (or flat body). Built into a Call, clustered, scored, persisted. Returns the full incident.
2. **`post_call_transcription`** — sent by ElevenLabs at end-of-call regardless of whether the tool fired.

   Dedupe logic: `tool_call_already_succeeded(body)` scans the conversation history for an `agent` entry with non-error `tool_results` whose `result_value` contains an incident id. If found → the live tool call already created the incident → return `{"detail": "tool already fired, no action"}`.

   Recovery: if the tool genuinely failed, `extract_params_from_conversation_history(body)` recovers the attempted tool params; otherwise we run Claude / regex extraction on the raw transcript.

   Both code paths handle two ElevenLabs body shapes: legacy `data.conversation_initiation_client_data.custom_llm_extra_body.system__conversation_history` (with `tool_requests`) and current `data.transcript` (with `tool_calls`).

> **Setup note:** the ElevenLabs tool URL must not have a trailing space — `POST /webhook/call ` (with space) returns 404.

### Transcript Extraction (fallback only)

When the tool didn't fire and we have only a raw transcript:
1. **Claude** (`extract_from_transcript_with_claude`) — if `ANTHROPIC_API_KEY` is set, sends the formatted transcript to Claude Haiku and gets back structured JSON.
2. **Regex** (`extract_from_transcript`) — keyword matching for emergency type, location, injuries, hazards, mobility, num_people, caller name. Pulls `situation` from the caller's first utterance.

### API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | Health check + counts |
| `POST` | `/webhook/call` | Tool call from ElevenLabs (or post-call transcription, deduped) |
| `POST` | `/webhook/call-end` | Alternative end-of-call hook |
| `GET` | `/incidents` | Active incidents sorted by score desc |
| `GET` | `/incidents/stream` | SSE — same payload pushed every second when changed |
| `DELETE` | `/incidents/{id}` | Hard-delete incident + its calls (memory + DB) |
| `GET` | `/stations/nearest?lat=&lng=&type=` | Closest real station of `type` (fire / ems / police / rescue) |

---

## Frontend (`frontend/src/`)

React + Vite app. Connects to the backend SSE stream and renders live.

### `hooks/useIncidents.js`
Opens an `EventSource` (via `event-source-polyfill` — needed because the native EventSource can't send the `ngrok-skip-browser-warning` header). Adapts raw backend incidents into frontend-friendly shape: maps `emergency_type` → display category (`Medical`, `Rescue`, `Structural`, etc.), computes `timeAgo`, pulls `situation` from the highest-scored call, aggregates `people` count. Exports `API_URL` and `API_HEADERS` for other components.

### `hooks/useDispatch.js`
Owns dispatch state and animation.
- Accepts an optional `selectedIncidentId` argument. When set, the GeoJSON outputs (`vehicleGeoJSON`, `routeGeoJSON`, `stationGeoJSON`) are filtered to that incident only — selecting a report on the sidebar reveals just its dispatched units, hiding everything else. Background simulation keeps running for hidden incidents.
- On Dispatch: queries `/stations/nearest` for each required responder type, then spawns N ephemeral vehicles per type from that station, fetches real Mapbox driving routes, and animates them via `requestAnimationFrame`.
- On Recall: removes the dispatch entirely from state.

### `components/Map.jsx`
Mapbox GL globe.
- Incidents — colored circles with halo / glow / pulse layers, color = tier color.
- Dispatched vehicles — animated markers driving from station to incident.
- Routes — dashed lines colored by responder type.
- Stations — dynamically rendered from `stationGeoJSON` (live from `useDispatch`), no longer hardcoded.
- Click an incident to select it; map flies to its centroid.

### `components/Sidebar.jsx`
Scrollable list of active incidents sorted by score. Each card shows tier badge, type, address, time-ago, clustered call count. Compact "active dispatches" sub-list with recall buttons.

### `components/IncidentDetail.jsx`
Slide-in panel for the selected incident. Shows:
- Emergency type + tier badge
- Caller's situation quote (their first utterance)
- Location, time reported, people count, clustered call count
- Priority score bar (Gemini's score)
- Required responders breakdown (fire / EMS / police / rescue counts)
- **Dispatch** button — calls `useDispatch.dispatch(incident)`. Disabled once dispatched.
- **Resolve** button — `DELETE /incidents/{id}`, hard-removes the incident.

### `components/DispatchPanel.jsx`
Inline summary list of dispatched units per active dispatch — vehicle ID, type, status (en-route / on-scene), originating station name.

### `components/KnowledgeGraph.jsx`
Toggleable view (TopBar button) showing the live incident graph via `@antv/g6` — incidents as nodes, with edges representing shared family / proximity. Clicking a node selects its incident.

### `components/TopBar.jsx`
Live header. Shows system name, current time, real counts (total active, critical, urgent), and the Knowledge Graph toggle.

### `data/constants.js`
`TIER_COLORS` and `TIER_RGB` keyed by `Critical / Urgent / Standard`.

### `data/vehicles.js`
`VEHICLE_CONFIG` (color/label per responder type). The legacy `BASE_STATIONS` and `INITIAL_VEHICLES` exports still exist for back-compat but are no longer the source of dispatch origins — `useDispatch.js` now hits `/stations/nearest` instead.

---

## ElevenLabs Agent (JP)

Voice agent named JP. Key behaviors:
- Lets the caller speak first — captures `situation` from their opening statement.
- Collects: `situation → caller_name → location (with city) → emergency_type → injuries → hazards → mobility`.
- Only asks `num_people` if the situation is clearly Critical (fire in a building, collapse, mass casualty).
- If the address has no city, follows up: "And what city is that in?"
- Repeats address back to caller to confirm before submitting.
- Calls `submit_emergency_report` (tool URL → `POST /webhook/call` on ngrok) with: `caller_name, location, emergency_type, situation, num_people, injuries, hazards, mobility`.

The post-call transcription webhook (workspace-level setting) also points to `/webhook/call`. The backend dedupes against the live tool call so a successful tool fire doesn't create a duplicate incident.

---

## Running Locally

```bash
# First time only
./install.sh                # installs backend venv + frontend npm deps

# Every time
./start.sh                  # backend, frontend, ngrok, cloudflared (all in nohup)
./stop.sh                   # kill them
```

Logs land in `/tmp/lah-logs/{backend,frontend,ngrok,cloudflared}.log`. Tail any of them while debugging:
```bash
tail -f /tmp/lah-logs/backend.log | grep -E "gemini|google|stations|gemini|history"
```

### Wiping demo state

To reset everything between demo runs:
```sql
truncate calls;
truncate incidents;
```
(in Supabase SQL editor) then `pkill -f uvicorn && ./start.sh`.

### Common pitfalls

- **`ERR_NGROK_334` on start** — your reserved domain is held by a phantom session. Open https://dashboard.ngrok.com/agents and disconnect, or wait ~5 min for auto-release.
- **Backend stuck on `Waiting for connections to close`** — uvicorn's graceful shutdown is blocked by the SSE stream from the frontend. `pkill -9 -f uvicorn` and restart.
- **Vite import error after pulling** — your teammate added a frontend dep. `cd frontend && npm install`.
- **Backend missing modules after pulling** — same on the backend. `backend/.venv/bin/pip install -r backend/requirements.txt`.
- **Trailing space in ElevenLabs tool URL** — produces `POST /webhook/call%20` → 404. Edit the tool config.
