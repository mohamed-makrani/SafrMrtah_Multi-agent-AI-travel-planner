"""
TripMate AI — Weather MCP Server (remote-capable)

Exposes OpenWeather data as MCP tools over **Streamable HTTP**, so the
TripMate backend (or any MCP client) can reach it by URL instead of
spawning it as a local subprocess.

Run (remote / HTTP — default):
    python custom_weather_mcp_server.py
    -> MCP endpoint: http://127.0.0.1:8001/mcp
    -> Health:       http://127.0.0.1:8001/health

Run (legacy local stdio, used only as a fallback by mcp_client.py):
    python custom_weather_mcp_server.py --stdio

Environment:
    OPENWEATHER_API_KEY   required — your OpenWeather key (stays on this server)
    WEATHER_MCP_TOKEN     optional — if set, clients must send
                          "Authorization: Bearer <token>"
    WEATHER_MCP_HOST      default 127.0.0.1 (use 0.0.0.0 when deployed)
    PORT / WEATHER_MCP_PORT   default 8001 (Render sets PORT automatically)
    OPENWEATHER_BASE_URL  default https://api.openweathermap.org
"""

import json
import os
import sys
from collections import Counter
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any

import requests
from dotenv import load_dotenv
from mcp.server.fastmcp import FastMCP
from starlette.requests import Request
from starlette.responses import JSONResponse


# =========================================================
# Configuration
# =========================================================

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")

OPENWEATHER_API_KEY = (os.getenv("OPENWEATHER_API_KEY") or "").strip()
OPENWEATHER_BASE_URL = (
    os.getenv("OPENWEATHER_BASE_URL") or "https://api.openweathermap.org"
).rstrip("/")

WEATHER_MCP_TOKEN = (os.getenv("WEATHER_MCP_TOKEN") or "").strip()
WEATHER_MCP_HOST = os.getenv("WEATHER_MCP_HOST", "127.0.0.1")
WEATHER_MCP_PORT = int(os.getenv("PORT") or os.getenv("WEATHER_MCP_PORT") or 8001)

REQUEST_TIMEOUT_SECONDS = 20


mcp = FastMCP(
    "TripMate Weather MCP Server",
    instructions=(
        "Live weather for travel planning. Use get_current_weather for "
        "current conditions and get_forecast for the next days."
    ),
    host=WEATHER_MCP_HOST,
    port=WEATHER_MCP_PORT,
    streamable_http_path="/mcp",
    # Stateless + JSON: every call is independent, which suits a remote
    # service that may restart or scale (e.g. on Render).
    stateless_http=True,
    json_response=True,
)


# =========================================================
# OpenWeather helpers
# =========================================================

def _get_api_key() -> str:
    if not OPENWEATHER_API_KEY:
        raise RuntimeError(
            "OPENWEATHER_API_KEY is missing on the weather MCP server."
        )
    return OPENWEATHER_API_KEY


def _request_json(path: str, params: dict[str, Any]) -> Any:
    url = f"{OPENWEATHER_BASE_URL}{path}"
    try:
        response = requests.get(
            url,
            params={**params, "appid": _get_api_key()},
            timeout=REQUEST_TIMEOUT_SECONDS,
        )
        response.raise_for_status()
        return response.json()

    except requests.RequestException as exc:
        status = getattr(getattr(exc, "response", None), "status_code", None)
        # Never echo the API key back to the client.
        raise RuntimeError(
            f"OpenWeather request to {path} failed"
            + (f" (HTTP {status})" if status else "")
            + f": {type(exc).__name__}"
        ) from exc


def _resolve_location(location: str) -> dict[str, Any]:
    """
    Turn a free-text place ("Dubai", "Paris, FR", "Marrakesh")
    into coordinates with OpenWeather's geocoding API.
    """

    query = " ".join((location or "").split()).strip(" ,.")
    if not query:
        raise ValueError("location cannot be empty")

    results = _request_json(
        "/geo/1.0/direct",
        {"q": query, "limit": 1},
    )

    if not results:
        raise ValueError(
            f"Location '{query}' was not found by OpenWeather geocoding. "
            "Use a city name, optionally with a country code (e.g. 'Paris, FR')."
        )

    place = results[0]
    return {
        "name": place.get("name") or query,
        "country": place.get("country", ""),
        "state": place.get("state", ""),
        "lat": place["lat"],
        "lon": place["lon"],
    }


def _compact(payload: dict[str, Any]) -> str:
    """
    Compact JSON text. The TripMate backend clips tool output to keep
    LLM context small, so whitespace-free JSON preserves more data.
    """
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def _local_date(unix_ts: int, tz_offset_seconds: int) -> str:
    return (
        datetime.fromtimestamp(unix_ts, tz=timezone.utc)
        + timedelta(seconds=tz_offset_seconds)
    ).strftime("%Y-%m-%d")


# =========================================================
# MCP tools (names kept identical to the previous server)
# =========================================================

@mcp.tool()
def get_current_weather(city: str) -> str:
    """Return the current weather for a city (metric units)."""

    place = _resolve_location(city)

    data = _request_json(
        "/data/2.5/weather",
        {"lat": place["lat"], "lon": place["lon"], "units": "metric"},
    )

    return _compact({
        "city": place["name"],
        "country": place["country"],
        "temperature_c": data["main"]["temp"],
        "feels_like_c": data["main"]["feels_like"],
        "humidity": data["main"]["humidity"],
        "condition": data["weather"][0]["description"],
        "wind_speed": data["wind"]["speed"],
        "source": "OpenWeather",
    })


@mcp.tool()
def get_forecast(city: str, days: int = 5) -> str:
    """
    Return a daily forecast summary (up to 5 days) plus the next
    few 3-hour entries for a city (metric units).
    """

    days = max(1, min(int(days or 5), 5))
    place = _resolve_location(city)

    data = _request_json(
        "/data/2.5/forecast",
        {"lat": place["lat"], "lon": place["lon"], "units": "metric"},
    )

    tz_offset = int(data.get("city", {}).get("timezone", 0) or 0)
    entries = data.get("list", [])

    # Aggregate 3-hour entries into local calendar days.
    by_day: dict[str, dict[str, Any]] = {}
    for item in entries:
        day = _local_date(item["dt"], tz_offset)
        bucket = by_day.setdefault(
            day,
            {"min": None, "max": None, "conditions": [], "pop": 0.0},
        )
        t_min = item["main"].get("temp_min", item["main"]["temp"])
        t_max = item["main"].get("temp_max", item["main"]["temp"])
        bucket["min"] = t_min if bucket["min"] is None else min(bucket["min"], t_min)
        bucket["max"] = t_max if bucket["max"] is None else max(bucket["max"], t_max)
        bucket["conditions"].append(item["weather"][0]["description"])
        bucket["pop"] = max(bucket["pop"], float(item.get("pop", 0) or 0))

    daily = [
        {
            "date": day,
            "min_c": round(values["min"], 1),
            "max_c": round(values["max"], 1),
            "condition": Counter(values["conditions"]).most_common(1)[0][0],
            "rain_chance": round(values["pop"] * 100),
        }
        for day, values in list(by_day.items())[:days]
    ]

    # Key order matters: the backend clips long tool output, so the
    # compact daily summary comes before the hourly detail.
    return _compact({
        "city": place["name"],
        "country": place["country"],
        "daily": daily,
        "forecast": [
            {
                "datetime": item["dt_txt"],
                "temperature_c": item["main"]["temp"],
                "condition": item["weather"][0]["description"],
            }
            for item in entries[:4]
        ],
        "source": "OpenWeather",
    })


# =========================================================
# Health check (for Render / uptime monitors)
# =========================================================

@mcp.custom_route("/health", methods=["GET"])
async def health(_: Request) -> JSONResponse:
    return JSONResponse(
        {
            "status": "ok",
            "service": "tripmate-weather-mcp",
            "openweather_key": bool(OPENWEATHER_API_KEY),
            "auth": bool(WEATHER_MCP_TOKEN),
        }
    )


# =========================================================
# Optional bearer-token protection for the remote endpoint
# =========================================================

class BearerTokenMiddleware:
    """
    Pure ASGI middleware (safe with streaming responses).
    Protects /mcp when WEATHER_MCP_TOKEN is set; /health stays public.
    """

    def __init__(self, app, token: str):
        self.app = app
        self.expected = f"Bearer {token}".encode()

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http" and scope.get("path", "").startswith("/mcp"):
            headers = dict(scope.get("headers") or [])
            if headers.get(b"authorization") != self.expected:
                response = JSONResponse(
                    {"error": "Unauthorized weather MCP request."},
                    status_code=401,
                )
                await response(scope, receive, send)
                return
        await self.app(scope, receive, send)


def build_http_app():
    app = mcp.streamable_http_app()
    if WEATHER_MCP_TOKEN:
        app = BearerTokenMiddleware(app, WEATHER_MCP_TOKEN)
    return app


# =========================================================
# Entry point
# =========================================================

if __name__ == "__main__":

    if "--stdio" in sys.argv:
        # Legacy mode: launched as a subprocess by mcp_client.py.
        mcp.run(transport="stdio")

    else:
        import uvicorn

        print(
            f"Weather MCP server: http://{WEATHER_MCP_HOST}:{WEATHER_MCP_PORT}/mcp "
            f"(auth {'on' if WEATHER_MCP_TOKEN else 'off'})",
            flush=True,
        )

        uvicorn.run(
            build_http_app(),
            host=WEATHER_MCP_HOST,
            port=WEATHER_MCP_PORT,
            log_level="info",
        )
