"""
Supabase / Postgres persistence backstop.

The runtime source of truth stays in main.py's in-memory dicts; this module
only mirrors mutations to Postgres and hydrates the dicts on startup so the
stack survives reloads. If SUPABASE_DB_URL isn't set, every function is a
no-op and the app behaves exactly as before.
"""

import json
import os
from datetime import datetime

import asyncpg


def _to_dt(value) -> datetime:
    """Coerce ISO strings to datetime; passthrough datetimes."""
    if isinstance(value, datetime):
        return value
    return datetime.fromisoformat(str(value))

_pool: asyncpg.Pool | None = None


async def _init_codec(conn: asyncpg.Connection) -> None:
    """Let us pass / receive Python dicts directly for jsonb columns."""
    await conn.set_type_codec(
        "jsonb",
        encoder=json.dumps,
        decoder=json.loads,
        schema="pg_catalog",
    )


async def init_pool() -> None:
    global _pool
    url = os.getenv("SUPABASE_DB_URL")
    if not url:
        print("[db] SUPABASE_DB_URL not set — running without persistence")
        return
    try:
        _pool = await asyncpg.create_pool(
            url,
            min_size=1,
            max_size=4,
            init=_init_codec,
            # Supabase pgbouncer (port 6543) runs in transaction mode and
            # disallows server-side prepared statements.
            statement_cache_size=0,
        )
        print("[db] connected to Supabase")
    except Exception as e:
        print(f"[db] connection failed: {e}")
        _pool = None


async def close_pool() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


def is_enabled() -> bool:
    return _pool is not None


async def save_call(call: dict) -> None:
    if _pool is None:
        return
    try:
        await _pool.execute(
            """
            insert into calls (id, incident_id, data)
            values ($1, $2, $3)
            on conflict (id) do update
              set incident_id = excluded.incident_id,
                  data        = excluded.data
            """,
            call["id"], call.get("incident_id"), call,
        )
    except Exception as e:
        print(f"[db] save_call error for {call.get('id')}: {e}")


async def save_incident(incident: dict) -> None:
    if _pool is None:
        return
    try:
        await _pool.execute(
            """
            insert into incidents (id, status, score, data, created_at, updated_at)
            values ($1, $2, $3, $4, $5, $6)
            on conflict (id) do update
              set status     = excluded.status,
                  score      = excluded.score,
                  data       = excluded.data,
                  updated_at = excluded.updated_at
            """,
            incident["id"],
            incident["status"],
            incident["score"],
            incident,
            _to_dt(incident["created_at"]),
            _to_dt(incident["updated_at"]),
        )
    except Exception as e:
        print(f"[db] save_incident error for {incident.get('id')}: {e}")


async def delete_incident(incident_id: str) -> None:
    """Hard-delete an incident and its calls from Postgres."""
    if _pool is None:
        return
    try:
        async with _pool.acquire() as conn:
            async with conn.transaction():
                await conn.execute("delete from calls where incident_id = $1", incident_id)
                await conn.execute("delete from incidents where id = $1", incident_id)
        print(f"[db] deleted incident {incident_id} and its calls")
    except Exception as e:
        print(f"[db] delete_incident error for {incident_id}: {e}")


async def hydrate(calls_dict: dict, incidents_dict: dict) -> None:
    """Load existing calls and incidents from Postgres into the in-memory dicts."""
    if _pool is None:
        return
    try:
        for row in await _pool.fetch("select id, data from calls"):
            calls_dict[row["id"]] = row["data"]
        for row in await _pool.fetch("select id, data from incidents"):
            incidents_dict[row["id"]] = row["data"]
        print(f"[db] hydrated {len(calls_dict)} calls, {len(incidents_dict)} incidents")
    except Exception as e:
        print(f"[db] hydrate error: {e}")
