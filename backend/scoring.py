"""
Incident urgency scoring.

Currently delegates to Google AI Studio (Gemini 2.5 Flash) — the LLM
takes the full clustered incident (one or more 911 calls + age + location)
and returns a 0–100 score plus a tier (Critical / Urgent / Standard).

The original rule-based scorers are kept here, commented out, for fast
fallback if Gemini is unavailable. To revert, swap the stubs at the top
for the bodies further down and call score_incident() instead of
score_incident_with_gemini() in main.py.
"""

import json
import os
from datetime import datetime
from typing import Any

import httpx
from pydantic import BaseModel


# ── Public stubs ──────────────────────────────────────────────────────────────
# These keep the surface area stable for callers in main.py. Real scoring
# happens in score_incident_with_gemini().

def score_call(payload: "BaseModel") -> tuple[int, str]:  # noqa: F821 (BaseModel hint)
    """Per-call scoring is no longer used. Gemini scores at the incident
    level using the full call list. Stored on every call only for schema
    compatibility — the frontend never reads it."""
    return 0, "Standard"


def score_incident(incident: dict) -> tuple[int, str]:
    """Returns whatever score Gemini last cached on this incident."""
    return incident.get("score", 0), incident.get("tier", "Standard")


# ── Gemini scoring ────────────────────────────────────────────────────────────
GEMINI_MODEL = "gemini-2.5-flash"
GEMINI_URL = (
    "https://generativelanguage.googleapis.com/v1beta/models/"
    f"{GEMINI_MODEL}:generateContent"
)

SCORING_SYSTEM_PROMPT = (
    "You are the urgency-triage component of a 911 dispatch system. "
    "You receive a clustered emergency incident (one or more 911 calls at "
    "the same location and emergency type) and assign it a priority score "
    "from 0 to 100 along with a tier.\n\n"
    "Tiers:\n"
    "- Critical (score 75–100): immediate life-threat. Active fire in a "
    "  building, mass casualties, cardiac arrest, active shooter / stabbing "
    "  in progress, structural collapse with people inside, gunshot wounds, "
    "  unconscious / not-breathing victims, multiple severe injuries, "
    "  hazards spreading uncontrollably (fire, gas leak, rising water).\n"
    "- Urgent (score 40–74): significant emergency requiring fast response "
    "  but not imminent mass-casualty. Single moderate injury, isolated "
    "  hazard, robbery without confirmed shots, contained car crashes with "
    "  injuries, person trapped without immediate life threat.\n"
    "- Standard (score 0–39): non-life-threatening. Minor injuries, no "
    "  active threats, routine response.\n\n"
    "Consider together:\n"
    "1. Severity of injuries (fatal / unconscious / gunshot wounds = max).\n"
    "2. Active hazards still spreading (fire spreading, gas leak, weapons, "
    "   rising water).\n"
    "3. Number of people affected — more people raises urgency, especially "
    "   when combined with active hazards.\n"
    "4. Mobility — trapped / immobile victims raise urgency in fire / "
    "   collapse / flood scenarios.\n"
    "5. Time in queue — older incidents should get a small priority boost.\n"
    "6. Cluster size — multiple independent calls at the same location is "
    "   stronger evidence of severity than a single call.\n\n"
    "Return ONLY a JSON object with keys: score (integer 0–100), tier "
    "(\"Critical\" | \"Urgent\" | \"Standard\"), reasoning (one short "
    "sentence). Be decisive — do not default to mid-range scores."
)


def _format_call_for_prompt(c: dict) -> str:
    return (
        f"  - caller={c.get('caller_name', 'Unknown')}; "
        f"emergency_type={c.get('emergency_type', 'unknown')}; "
        f"num_people={c.get('num_people', 1)}; "
        f"injuries={c.get('injuries', 'none')}; "
        f"hazards={c.get('hazards', 'none')}; "
        f"mobility={c.get('mobility', 'mobile')}; "
        f"situation={c.get('situation', '') or 'n/a'}"
    )


async def score_incident_with_gemini(
    incident: dict,
    icalls: list[dict],
) -> tuple[int, str]:
    """
    Ask Gemini 2.5 Flash to score this incident. Returns (score, tier).
    Falls back to (50, 'Urgent') if no API key or the request fails.
    """
    api_key = os.getenv("GOOGLE_AI_API_KEY") or os.getenv("GEMINI_API_KEY")
    if not api_key:
        print("[gemini] GOOGLE_AI_API_KEY not set — defaulting to (50, Urgent)")
        return 50, "Urgent"

    if not icalls:
        return 0, "Standard"

    try:
        age_min = (
            datetime.utcnow() - datetime.fromisoformat(incident["created_at"])
        ).total_seconds() / 60
    except Exception:
        age_min = 0.0

    user_text = (
        f"Incident metadata:\n"
        f"  primary_emergency_type: {incident.get('primary_emergency_type', 'unknown')}\n"
        f"  location: {incident.get('location_label', 'unknown')}\n"
        f"  clustered_call_count: {len(icalls)}\n"
        f"  age_minutes: {age_min:.1f}\n\n"
        f"Calls in this cluster:\n"
        + "\n".join(_format_call_for_prompt(c) for c in icalls)
    )

    body = {
        "systemInstruction": {"parts": [{"text": SCORING_SYSTEM_PROMPT}]},
        "contents": [{"role": "user", "parts": [{"text": user_text}]}],
        "generationConfig": {
            "temperature": 0,
            "responseMimeType": "application/json",
            "responseSchema": {
                "type": "object",
                "properties": {
                    "score":     {"type": "integer"},
                    "tier":      {"type": "string", "enum": ["Critical", "Urgent", "Standard"]},
                    "reasoning": {"type": "string"},
                },
                "required": ["score", "tier"],
            },
        },
    }

    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(
                GEMINI_URL,
                params={"key": api_key},
                json=body,
                headers={"Content-Type": "application/json"},
            )
            resp.raise_for_status()
            data = resp.json()
            text = data["candidates"][0]["content"]["parts"][0]["text"]
            parsed = json.loads(text)
    except httpx.HTTPStatusError as e:
        print(f"[gemini] HTTP {e.response.status_code}: {e.response.text[:200]}")
        return 50, "Urgent"
    except Exception as e:
        print(f"[gemini] error: {e}")
        return 50, "Urgent"

    score = int(parsed.get("score", 50))
    score = max(0, min(100, score))
    tier = parsed.get("tier", "Urgent")
    if tier not in ("Critical", "Urgent", "Standard"):
        # Re-derive from score if Gemini sent an unexpected tier label.
        tier = "Critical" if score >= 75 else ("Urgent" if score >= 40 else "Standard")

    reasoning = (parsed.get("reasoning") or "").replace("\n", " ")[:120]
    print(
        f"[gemini] incident {incident['id'][:8]} → score={score} tier={tier} "
        f"calls={len(icalls)} reasoning='{reasoning}'"
    )
    return score, tier


# # ── Rule-based scorers (DISABLED — Gemini owns scoring; kept as fallback) ───
# # The expanded version (commit 50e861c) — INSTANT_CRITICAL keyword auto-trip,
# # broader injury / hazard / mobility / cluster matchers, tighter non-linear
# # bonuses. To revert: uncomment everything below, swap the stubs at the top
# # of this file for these definitions, and remove the awaited Gemini call from
# # main.py's _score_with_gemini_and_persist.
#
# import math
#
# CRITICAL_HAZARDS = ["fire spreading", "gas leak", "weapons", "rising water"]
# TIME_DECAY_SLOPE = 0.4
# TIME_DECAY_CAP = 20
#
# def score_call(payload) -> tuple[int, str]:
#     score = 0
#     etype = payload.emergency_type.lower()
#     injuries = (payload.injuries or "").lower()
#     hazards = (payload.hazards or "").lower()
#     mobility = (payload.mobility or "").lower()
#     n = payload.num_people or 1
#
#     # Immediate life threat — auto-Critical
#     INSTANT_CRITICAL = [
#         "dying", "going to die", "not breathing", "stopped breathing",
#         "no pulse", "unconscious", "unresponsive", "head", "decapitat",
#         "severed", "bleeding out", "can't breathe", "cannot breathe",
#         "heart attack", "cardiac arrest", "overdose", "drowning",
#         "on fire", "trapped in fire", "shooting", "shot", "stabbed",
#         "choking", "stroke", "seizure",
#         "multiple casualties", "mass casualty", "seven people injured",
#         "several people injured", "multiple injured", "all trapped",
#     ]
#     if any(k in injuries for k in INSTANT_CRITICAL) or \
#        any(k in etype for k in INSTANT_CRITICAL):
#         return 95, "Critical"
#
#     # Emergency type base
#     HIGH   = ["cardiac arrest", "fire", "structural collapse", "shooting",
#               "stabbing", "earthquake", "collapse", "trapped", "rescue", "crush"]
#     MEDIUM = ["flooding", "car accident", "medical", "injury"]
#     if any(e in etype for e in HIGH):
#         score += 40
#     elif any(e in etype for e in MEDIUM):
#         score += 25
#     else:
#         score += 5
#
#     # Injury severity
#     SEVERE   = ["unconscious", "not breathing", "heavy bleeding", "severe bleeding",
#                 "critical", "dying", "life threatening", "decapitat", "severed",
#                 "bleeding out", "no pulse", "unresponsive",
#                 "crush", "crushing", "debris", "buried", "pinned",
#                 "multiple injured", "seven injured", "several injured",
#                 "multiple people injured"]
#     MODERATE = ["bleeding", "broken", "fracture", "head injury", "chest pain",
#                 "difficulty breathing", "severe pain", "cut", "laceration"]
#     if any(k in injuries for k in SEVERE):
#         score += 40
#     elif any(k in injuries for k in MODERATE):
#         score += 20
#     elif injuries and injuries not in ("none", "no", "n/a", "unknown"):
#         score += 10
#
#     # Hazards (expanded list)
#     CRITICAL_HAZARDS_EXPANDED = [
#         "fire spreading", "gas leak", "weapons", "rising water",
#         "explosion", "armed", "gun", "knife", "power line",
#     ]
#     hazard_hits = sum(1 for h in CRITICAL_HAZARDS_EXPANDED if h in hazards)
#     score += hazard_hits * 12
#     if hazards and hazards not in ("none", "no", "n/a") and hazard_hits == 0:
#         score += 5
#
#     # Mobility
#     if any(k in mobility for k in ("trapped", "unable to move", "cannot move", "immobile", "stuck")):
#         score += 15
#
#     # Number of people
#     if n >= 10:    score += 25
#     elif n >= 7:   score += 18
#     elif n >= 5:   score += 12
#     elif n >= 3:   score += 7
#     elif n >= 2:   score += 3
#
#     # Non-linear combos
#     if "fire" in etype and n >= 3:
#         score = int(score * 1.3)
#     if any(k in mobility for k in ("trapped", "unable to move")) and hazard_hits > 0:
#         score += 15
#     if any(k in injuries for k in SEVERE) and n >= 2:
#         score += 10
#     if n >= 5 and any(k in mobility for k in ("trapped", "cannot move", "all trapped")):
#         score += 20
#
#     score = min(100, max(0, score))
#     tier = "Critical" if score >= 70 else ("Urgent" if score >= 40 else "Standard")
#     return score, tier
#
#
# def score_incident(incident: dict, icalls: list[dict]) -> tuple[int, str]:
#     if not icalls:
#         return 0, "Standard"
#     severities = [c["call_score"] for c in icalls]
#     max_sev = max(severities)
#     avg_sev = sum(severities) / len(severities)
#     n = len(icalls)
#     unique_hazards: set[str] = set()
#     for c in icalls:
#         h = (c["hazards"] or "").lower()
#         for tok in CRITICAL_HAZARDS:
#             if tok in h:
#                 unique_hazards.add(tok)
#     age_s = (datetime.utcnow() - datetime.fromisoformat(incident["created_at"])).total_seconds()
#     age_min = age_s / 60
#     time_bonus = min(TIME_DECAY_CAP, age_min * TIME_DECAY_SLOPE)
#     score = (
#         max_sev
#         + 0.3 * avg_sev
#         + 8 * math.log2(n + 1)
#         + 4 * len(unique_hazards)
#         + time_bonus
#     )
#     score = int(min(100, max(0, score)))
#     tier = "Critical" if score >= 75 else ("Urgent" if score >= 40 else "Standard")
#     return score, tier
