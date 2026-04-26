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
import math
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
    "You are the triage and dispatch-planning component of a 911 emergency system. "
    "Given a clustered incident (one or more 911 calls at the same location), you must:\n"
    "1. Assign a priority score (0–100) and tier.\n"
    "2. Determine exactly how many fire trucks, ambulances, and police units to dispatch.\n\n"
    "Tiers:\n"
    "- Critical (score 75–100): immediate life-threat — active building fire, mass casualties, "
    "  cardiac arrest, active shooter, structural collapse with trapped victims, "
    "  uncontrolled hazards (fire spreading, gas leak, rising water).\n"
    "- Urgent (score 40–74): significant emergency — moderate injuries, isolated hazard, "
    "  robbery without shots, contained crash with injuries, person trapped without immediate threat.\n"
    "- Standard (score 0–39): non-life-threatening — minor injuries, no active threats.\n\n"
    "Scoring factors:\n"
    "1. Injury severity (fatal / unconscious / gunshot = max score).\n"
    "2. Active spreading hazards (fire, gas leak, weapons, rising water).\n"
    "3. Number of people — more people raises urgency when combined with active hazards.\n"
    "4. Mobility — trapped victims in fire/collapse/flood raise score significantly.\n"
    "5. Age in queue — older incidents get a small boost.\n"
    "6. Cluster size — multiple independent calls confirm severity.\n\n"
    "Dispatch guidelines (use your judgment — these are starting points):\n"
    "- fire: 1 for small/contained, 2-3 for structure fires, 4+ for mass-casualty/spreading fires.\n"
    "- ems: 1 for single patient, 2-3 for multiple injuries, 4+ for mass casualty.\n"
    "- police: 0 for medical-only, 1-2 for most incidents, 3+ for violence/active threat.\n"
    "- Scale ALL units up proportionally for large people counts (50+ people = multiply baselines).\n\n"
    "Return ONLY a JSON object. Be decisive — do not default to mid-range scores or minimum unit counts."
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
) -> tuple[int, str, dict]:
    """
    Ask Gemini 2.5 Flash to score this incident and determine dispatch counts.
    Returns (score, tier, required_responders).
    Falls back to rule-based if no API key or the request fails.
    """
    api_key = os.getenv("GOOGLE_AI_API_KEY") or os.getenv("GEMINI_API_KEY")
    if not api_key:
        print("[gemini] GOOGLE_AI_API_KEY not set — falling back to rule-based scorer")
        return _rule_based_score(incident, icalls)

    if not icalls:
        return 0, "Standard", {"fire": 0, "ems": 1, "police": 0}

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
                    "required_responders": {
                        "type": "object",
                        "properties": {
                            "fire":   {"type": "integer"},
                            "ems":    {"type": "integer"},
                            "police": {"type": "integer"},
                        },
                        "required": ["fire", "ems", "police"],
                    },
                },
                "required": ["score", "tier", "required_responders"],
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
        print(f"[gemini] HTTP {e.response.status_code}: {e.response.text[:200]} — falling back to rule-based scorer")
        return _rule_based_score(incident, icalls)
    except Exception as e:
        print(f"[gemini] error: {e} — falling back to rule-based scorer")
        return _rule_based_score(incident, icalls)

    score = int(parsed.get("score", 50))
    score = max(0, min(100, score))
    tier = parsed.get("tier", "Urgent")
    if tier not in ("Critical", "Urgent", "Standard"):
        tier = "Critical" if score >= 75 else ("Urgent" if score >= 40 else "Standard")

    raw_resp = parsed.get("required_responders") or {}
    responders = {
        "fire":   max(0, int(raw_resp.get("fire",   0))),
        "ems":    max(0, int(raw_resp.get("ems",    1))),
        "police": max(0, int(raw_resp.get("police", 0))),
    }

    reasoning = (parsed.get("reasoning") or "").replace("\n", " ")[:120]
    print(
        f"[gemini] incident {incident['id'][:8]} → score={score} tier={tier} "
        f"responders={responders} calls={len(icalls)} reasoning='{reasoning}'"
    )
    return score, tier, responders


def _rule_based_score(incident: dict, icalls: list[dict]) -> tuple[int, str, dict]:
    """Fallback when Gemini is unavailable."""
    if not icalls:
        return 0, "Standard", {"fire": 0, "ems": 1, "police": 0}
    etype     = (incident.get("primary_emergency_type") or "").lower()
    injuries  = " ".join((c.get("injuries")  or "") for c in icalls).lower()
    hazards   = " ".join((c.get("hazards")   or "") for c in icalls).lower()
    mobility  = " ".join((c.get("mobility")  or "") for c in icalls).lower()
    max_people = max((c.get("num_people") or 1) for c in icalls)

    score = 20
    if any(k in etype or k in injuries for k in ("fire","collapse","cardiac","shoot","stab","trapped","explosion")):
        score += 40
    elif any(k in etype for k in ("flood","crash","accident","medical")):
        score += 20
    if any(k in injuries for k in ("unconscious","not breathing","severe","dying","bleeding out")):
        score += 25
    if any(k in hazards for k in ("fire spreading","gas leak","weapons","rising water")):
        score += 15
    if any(k in mobility for k in ("trapped","cannot move","immobile")):
        score += 10
    if max_people >= 100: score += 20
    elif max_people >= 10: score += 10
    elif max_people >= 3: score += 5
    score = min(100, score)
    tier = "Critical" if score >= 75 else ("Urgent" if score >= 40 else "Standard")

    fire = 2 if "fire" in etype or "collapse" in etype else 0
    ems  = max(1, min(6, max_people // 2)) if max_people > 1 else 1
    police = 2 if any(k in etype for k in ("shoot","stab","violence")) else 1
    if max_people >= 50:
        fire = max(fire, 3); ems = max(ems, 4); police = max(police, 2)

    return score, tier, {"fire": fire, "ems": ems, "police": police}


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
