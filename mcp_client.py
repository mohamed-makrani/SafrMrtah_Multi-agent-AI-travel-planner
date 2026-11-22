import os
import shutil
import sys
import re
from datetime import timedelta
from pathlib import Path
from typing import Any

import certifi
from dotenv import load_dotenv
from langchain_groq import ChatGroq
from langchain_mcp_adapters.client import MultiServerMCPClient


# =========================================================
# Environment setup
# =========================================================

BASE_DIR = Path(__file__).resolve().parent

load_dotenv(BASE_DIR / ".env")

os.environ["SSL_CERT_FILE"] = certifi.where()
os.environ["REQUESTS_CA_BUNDLE"] = certifi.where()


# =========================================================
# API Keys
# =========================================================

TAVILY_API_KEY = os.getenv("TAVILY_API_KEY")

AVIATION_STACK_API_KEY = (
    os.getenv("AVIATION_STACK_API_KEY")
    or os.getenv("AVIATIONSTACK_API_KEY")
)

OPENWEATHER_API_KEY = os.getenv("OPENWEATHER_API_KEY")

GROQ_API_KEY = os.getenv("GROQ_API_KEY")


# =========================================================
# MCP configuration
# =========================================================

WEATHER_SERVER_PATH = (
    BASE_DIR / "custom_weather_mcp_server.py"
)

# =========================================================
# AviationStack MCP launcher
# =========================================================
#
# The AviationStack MCP server is a Python package
# ("aviationstack-mcp"). It used to require `uvx` on PATH, which fails on
# machines where uv is not installed or the terminal PATH is stale.
# We now try, in order:
#
#   1. the aviationstack-mcp program installed with `uv tool install`
#   2. uvx found on PATH
#   3. uvx in the active venv / uv's default install folders
#   4. the `uv` Python package (pip install uv) -> python -m uv tool run
#   5. the aviationstack_mcp package installed in this environment
#
# Override with AVIATIONSTACK_MCP_COMMAND (full command line) if needed.

AVIATIONSTACK_PACKAGE = "aviationstack-mcp"


def _find_uvx() -> str | None:

    found = shutil.which("uvx")

    if found:
        return found

    exe = "uvx.exe" if os.name == "nt" else "uvx"

    candidates = [
        Path(sys.executable).parent / exe,                 # venv Scripts/ or bin/
        Path(sys.prefix) / ("Scripts" if os.name == "nt" else "bin") / exe,
        Path.home() / ".local" / "bin" / exe,               # uv standalone installer
        Path.home() / ".cargo" / "bin" / exe,
    ]

    if os.name == "nt" and os.getenv("LOCALAPPDATA"):
        candidates.append(
            Path(os.environ["LOCALAPPDATA"]) / "Programs" / "uv" / exe
        )

    for candidate in candidates:
        if candidate.is_file():
            return str(candidate)

    return None


def _module_available(name: str) -> bool:

    import importlib.util

    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError):
        return False


def _aviationstack_launcher() -> tuple[str, list[str], str] | None:
    """
    Return (command, args, description) for the AviationStack MCP server,
    or None when no launch method is available.
    """

    override = (os.getenv("AVIATIONSTACK_MCP_COMMAND") or "").strip()

    if override:
        import shlex

        parts = shlex.split(override, posix=os.name != "nt")
        return parts[0], parts[1:], "AVIATIONSTACK_MCP_COMMAND"

    # Installed once with `uv tool install aviationstack-mcp` (setup_venv.bat,
    # Dockerfile): start it directly, nothing is downloaded at request time.
    installed = shutil.which(AVIATIONSTACK_PACKAGE)

    if not installed:
        exe = AVIATIONSTACK_PACKAGE + (".exe" if os.name == "nt" else "")
        candidate = Path.home() / ".local" / "bin" / exe
        installed = str(candidate) if candidate.is_file() else None

    if installed:
        return installed, [], f"installed tool ({installed})"

    uvx = _find_uvx()

    if uvx:
        return uvx, [AVIATIONSTACK_PACKAGE], f"uvx ({uvx})"

    if _module_available("uv"):
        return (
            sys.executable,
            ["-m", "uv", "tool", "run", AVIATIONSTACK_PACKAGE],
            "python -m uv tool run",
        )

    if _module_available("aviationstack_mcp"):
        return (
            sys.executable,
            ["-m", "aviationstack_mcp"],
            "installed aviationstack_mcp package",
        )

    return None


AVIATIONSTACK_LAUNCHER = _aviationstack_launcher()

if AVIATIONSTACK_LAUNCHER:
    print(
        f"AviationStack MCP launcher: {AVIATIONSTACK_LAUNCHER[2]}",
        flush=True,
    )

# Kept for backward compatibility with older code paths.
UVX_COMMAND = (
    AVIATIONSTACK_LAUNCHER[0] if AVIATIONSTACK_LAUNCHER else "uvx"
)


# Remote weather MCP (Streamable HTTP). When WEATHER_MCP_URL is set the
# backend talks to the weather server by URL; the OpenWeather key then
# lives on that server. Without it, the legacy local stdio server is used.
#
#   WEATHER_MCP_URL=http://127.0.0.1:8001/mcp          (local service)
#   WEATHER_MCP_URL=https://<your-service>.onrender.com/mcp  (deployed)
#   WEATHER_MCP_TOKEN=<same token as on the weather server>  (optional)

WEATHER_MCP_URL = (os.getenv("WEATHER_MCP_URL") or "").strip()

# On Render the weather service's private address arrives as "host:port".
_weather_hostport = (os.getenv("WEATHER_MCP_HOSTPORT") or "").strip()

if not WEATHER_MCP_URL and _weather_hostport:
    WEATHER_MCP_URL = f"http://{_weather_hostport}/mcp"

WEATHER_MCP_TOKEN = (os.getenv("WEATHER_MCP_TOKEN") or "").strip()

WEATHER_LOCAL_FALLBACK = (
    os.getenv("WEATHER_MCP_LOCAL_FALLBACK", "true").strip().lower()
    not in {"0", "false", "no", "off"}
)


# =========================================================
# Environment helpers
# =========================================================

def _require_env(
    name: str,
    value: str | None
) -> str:

    if not value:
        raise RuntimeError(
            f"{name} is missing. "
            f"Add {name}=your_key to the project .env file."
        )

    return value


def _subprocess_env(
    **updates: str | None
) -> dict[str, str]:

    env = os.environ.copy()

    for key, value in updates.items():

        if value:
            env[key] = value

    return env


# =========================================================
# LLM
# =========================================================

llm = ChatGroq(
    model="openai/gpt-oss-120b",
    api_key=_require_env(
        "GROQ_API_KEY",
        GROQ_API_KEY
    ),
    max_tokens=700,
)


# =========================================================
# MCP Client
# =========================================================

client = MultiServerMCPClient(
    {

        # -------------------------------------------------
        # Tavily
        # -------------------------------------------------

        "tavily": {
            "transport": "streamable_http",
            "url": (
                "https://mcp.tavily.com/mcp/"
                f"?tavilyApiKey={TAVILY_API_KEY or ''}"
            ),
        },

        # -------------------------------------------------
        # AviationStack
        # -------------------------------------------------

        "aviationstack": {
            "transport": "stdio",
            "command": (
                AVIATIONSTACK_LAUNCHER[0]
                if AVIATIONSTACK_LAUNCHER
                else "uvx"
            ),
            "args": (
                AVIATIONSTACK_LAUNCHER[1]
                if AVIATIONSTACK_LAUNCHER
                else [AVIATIONSTACK_PACKAGE]
            ),
            "env": _subprocess_env(
                AVIATION_STACK_API_KEY=AVIATION_STACK_API_KEY,
            ),
        },

        # -------------------------------------------------
        # Weather — remote (Streamable HTTP) when configured
        # -------------------------------------------------

        "weather": (
            {
                "transport": "streamable_http",
                "url": WEATHER_MCP_URL,
                "headers": (
                    {"Authorization": f"Bearer {WEATHER_MCP_TOKEN}"}
                    if WEATHER_MCP_TOKEN
                    else {}
                ),
                "timeout": timedelta(seconds=30),
            }
            if WEATHER_MCP_URL
            else {
                "transport": "stdio",
                "command": sys.executable,
                "args": [str(WEATHER_SERVER_PATH), "--stdio"],
                "env": _subprocess_env(
                    OPENWEATHER_API_KEY=OPENWEATHER_API_KEY,
                ),
            }
        ),

        # -------------------------------------------------
        # Weather — local stdio fallback
        # -------------------------------------------------

        "weather_local": {
            "transport": "stdio",

            # Uses Python from the currently
            # activated environment.
            "command": sys.executable,

            "args": [
                str(WEATHER_SERVER_PATH),
                "--stdio",
            ],

            "env": _subprocess_env(
                OPENWEATHER_API_KEY=OPENWEATHER_API_KEY,
            ),
        },
    }
)


# =========================================================
# Get one MCP tool
# =========================================================

async def _get_server_tool(
    server_name: str,
    tool_name: str,
):

    if server_name == "tavily":

        _require_env(
            "TAVILY_API_KEY",
            TAVILY_API_KEY,
        )

    elif server_name == "aviationstack":

        _require_env(
            "AVIATION_STACK_API_KEY",
            AVIATION_STACK_API_KEY,
        )

        if AVIATIONSTACK_LAUNCHER is None:

            raise RuntimeError(
                "No way to start the AviationStack MCP server was found. "
                "Run `pip install uv` in the project environment "
                "(or `pip install -r requirements.txt`) and restart the app."
            )

    elif server_name == "weather" and WEATHER_MCP_URL:

        # Remote server holds the OpenWeather key — nothing to check here.
        pass

    elif server_name in ("weather", "weather_local"):

        _require_env(
            "OPENWEATHER_API_KEY",
            OPENWEATHER_API_KEY,
        )

        if not WEATHER_SERVER_PATH.is_file():

            raise FileNotFoundError(
                f"Weather MCP server not found: "
                f"{WEATHER_SERVER_PATH}"
            )

    tools = await client.get_tools(
        server_name=server_name,
    )

    tool = next(
        (
            item
            for item in tools
            if item.name == tool_name
        ),
        None,
    )

    if tool is None:

        available_tools = (
            ", ".join(
                sorted(
                    item.name
                    for item in tools
                )
            )
            or "none"
        )

        raise RuntimeError(
            f"MCP tool '{tool_name}' was not found "
            f"on server '{server_name}'. "
            f"Available tools: {available_tools}"
        )

    return tool


# =========================================================
# MCP connection test
# =========================================================

async def get_all_tools() -> None:

    for server_name in (
        "tavily",
        "aviationstack",
        "weather",
    ):

        try:

            tools = await client.get_tools(
                server_name=server_name,
            )

            tool_names = (
                ", ".join(
                    tool.name
                    for tool in tools
                )
                or "no tools"
            )

            print(
                f"{server_name}: OK -> "
                f"{tool_names}"
            )

        except Exception as exc:

            print(
                f"{server_name}: FAILED -> "
                f"{type(exc).__name__}: {exc}"
            )


# =========================================================
# Tavily MCP
# =========================================================

async def tavily_mcp_search(
    query: str
):

    search_tool = await _get_server_tool(
        "tavily",
        "tavily_search",
    )

    return await search_tool.ainvoke(
        {
            "query": query,
        }
    )


# =========================================================
# AviationStack MCP
# =========================================================

async def aviation_mcp_call(
    tool_name: str,
    tool_args: dict[str, Any] | None = None,
):

    aviation_tool = await _get_server_tool(
        "aviationstack",
        tool_name,
    )

    return await aviation_tool.ainvoke(
        tool_args or {}
    )


# =========================================================
# Weather MCP
# =========================================================

def _raise_on_tool_error(result: Any) -> Any:
    """
    langchain-mcp-adapters returns MCP tool errors as text content
    ("Error executing tool ...") instead of raising. Turn them into
    exceptions so agents never treat an error message as weather data.
    """

    text = str(result)

    if "Error executing tool" in text:

        match = re.search(
            r"Error executing tool [\w-]+: (.+?)['\"],\s*'id'",
            text,
        )

        raise RuntimeError(
            match.group(1) if match else text[:300]
        )

    return result


async def _weather_call(
    tool_name: str,
    args: dict[str, Any],
):
    """
    Call a weather tool on the remote MCP server; if it cannot be
    reached (server down, network error), fall back to the local
    stdio server so travel planning still gets live weather.
    """

    try:

        tool = await _get_server_tool(
            "weather",
            tool_name,
        )

        return _raise_on_tool_error(
            await tool.ainvoke(args)
        )

    except Exception as exc:

        # A "location not found" answer from a working server is a real
        # result, not an outage — do not retry it locally.
        message = str(exc)

        if (
            not WEATHER_MCP_URL
            or not WEATHER_LOCAL_FALLBACK
            or "not found by OpenWeather" in message
        ):
            raise

        print(
            f"Remote weather MCP unavailable ({type(exc).__name__}: "
            f"{message[:200]}). Falling back to local stdio server.",
            flush=True,
        )

        tool = await _get_server_tool(
            "weather_local",
            tool_name,
        )

        return _raise_on_tool_error(
            await tool.ainvoke(args)
        )


async def weather_mcp_search(
    city: str
):

    return await _weather_call(
        "get_current_weather",
        {"city": city},
    )


async def forecast_mcp_search(
    city: str
):

    return await _weather_call(
        "get_forecast",
        {"city": city},
    )


# =========================================================
# Destination extractor
# =========================================================

def extract_destination(
    query: str
) -> str:
    """
    Deterministic destination extraction.

    IMPORTANT:
    This function does NOT use Groq.

    This saves tokens and avoids an unnecessary
    LLM request for a simple extraction task.
    """

    if not query or not query.strip():

        raise ValueError(
            "Travel query is empty."
        )

    # Normalize spaces
    text = " ".join(
        query.strip().split()
    )

    # =====================================================
    # Common patterns
    # =====================================================

    patterns = [

        # "trip from Dhaka to Dubai", "flights from Casablanca to Paris"
        r"\bfrom\s+[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\s-]*?\s+to\s+([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\s-]*?)(?:\s+(?:for|with|including|under|in|on|during|and)\b|[,.!?]|$)",

        # "trip to Dubai from Morocco"
        r"\btrip\s+to\s+([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\s-]*?)(?:\s+from\b|\s+under\b|\s+for\b|\s+with\b|[,.!?]|$)",

        # "travel to Japan from Bangladesh"
        r"\btravel\s+to\s+([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\s-]*?)(?:\s+from\b|\s+under\b|\s+for\b|\s+with\b|[,.!?]|$)",

        # "visit Paris"
        r"\bvisit\s+([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\s-]*?)(?:\s+from\b|\s+under\b|\s+for\b|\s+with\b|[,.!?]|$)",

        # "vacation in Thailand"
        r"\bvacation\s+in\s+([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\s-]*?)(?:\s+from\b|\s+under\b|\s+for\b|\s+with\b|[,.!?]|$)",

        # "holiday in Dubai"
        r"\bholiday\s+in\s+([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\s-]*?)(?:\s+from\b|\s+under\b|\s+for\b|\s+with\b|[,.!?]|$)",

        # "going to Japan"
        r"\bgoing\s+to\s+([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\s-]*?)(?:\s+from\b|\s+under\b|\s+for\b|\s+with\b|[,.!?]|$)",
    ]

    # =====================================================
    # Try common patterns
    # =====================================================

    for pattern in patterns:

        match = re.search(
            pattern,
            text,
            flags=re.IGNORECASE,
        )

        if match:

            destination = (
                match.group(1)
                .strip()
                .rstrip(".,!?")
            )

            if destination:

                return destination

    # =====================================================
    # "7 days Japan trip"
    # =====================================================

    match = re.search(
        r"\b(?:\d+\s+days?\s+)"
        r"([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\s-]*?)"
        r"\s+trip\b",
        text,
        flags=re.IGNORECASE,
    )

    if match:

        destination = (
            match.group(1)
            .strip()
            .rstrip(".,!?")
        )

        if destination:

            return destination

    # =====================================================
    # "Japan trip"
    # =====================================================

    match = re.search(
        r"\b([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\s-]*?)"
        r"\s+trip\b",
        text,
        flags=re.IGNORECASE,
    )

    if match:

        destination = (
            match.group(1)
            .strip()
            .rstrip(".,!?")
        )

        destination = re.sub(
            r"^(a|an|the|complete|plan|my)\s+",
            "",
            destination,
            flags=re.IGNORECASE,
        ).strip()

        if destination:

            return destination

    # =====================================================
    # Extraction failed
    # =====================================================

    raise ValueError(
        "Could not determine the destination "
        "from the travel request. "
        "Please specify a destination such as "
        "'trip to Dubai' or 'trip to Japan'."
    )