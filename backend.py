import os
import certifi
from dotenv import load_dotenv

load_dotenv()

os.environ["SSL_CERT_FILE"] = certifi.where()
os.environ["REQUESTS_CA_BUNDLE"] = certifi.where()

from typing import Any, TypedDict, Annotated
import operator
import uuid
import asyncio
import json
import re

import psycopg
from psycopg.rows import dict_row

from langgraph.graph import StateGraph, START, END
from langgraph.checkpoint.postgres import PostgresSaver
from langgraph.types import Command, interrupt

from langchain_core.messages import (
    AnyMessage,
    HumanMessage,
    AIMessage,
    SystemMessage,
)

from langchain_groq import ChatGroq

from mcp_client import (
    tavily_mcp_search,
    aviation_mcp_call,
    extract_destination,
    forecast_mcp_search,
    weather_mcp_search,
)


# =========================================================
# DATABASE
# =========================================================

def get_database_url():
    database_url = os.getenv("DATABASE_URL")

    if not database_url:
        raise ValueError(
            "DATABASE_URL is missing. "
            "Please add your Render PostgreSQL External Database URL to .env"
        )

    if "sslmode=" not in database_url:
        separator = "&" if "?" in database_url else "?"
        database_url = f"{database_url}{separator}sslmode=require"

    return database_url


# =========================================================
# GROQ
# =========================================================

GROQ_API_KEY = os.getenv("GROQ_API_KEY")

if not GROQ_API_KEY:
    raise ValueError(
        "GROQ_API_KEY is missing. Please add it to your .env file."
    )


llm = ChatGroq(
    model="openai/gpt-oss-120b",
    api_key=GROQ_API_KEY,
)


# =========================================================
# STATE
# =========================================================

class TravelState(TypedDict, total=False):

    messages: Annotated[list[AnyMessage], operator.add]

    user_query: str

    # Supervisor / guardrail
    guardrail_allowed: bool
    guardrail_reason: str

    selected_agents: list[str]
    trip_constraints: dict[str, Any]
    supervisor_reasoning: str

    # Specialist results
    flight_results: str
    hotel_results: str
    weather_results: str
    budget_results: str

    # Itinerary
    itinerary: str
    approval_request: str

    # HITL
    approved: bool
    human_feedback: str

    # Final
    final_response: str

    # Monitoring
    llm_calls: int


# =========================================================
# AGENTS
# =========================================================

KNOWN_AGENTS = {
    "flight_agent",
    "hotel_agent",
    "weather_agent",
    "budget_agent",
    "itinerary_agent",
}


AGENT_ORDER = [
    "flight_agent",
    "hotel_agent",
    "weather_agent",
    "budget_agent",
    "itinerary_agent",
]


# =========================================================
# TOKEN / CONTEXT CONTROL
# =========================================================

def _clip(value: Any, limit: int) -> str:
    """
    Limit the amount of text sent to the LLM.

    MCP responses can be very large, so we keep
    only the useful beginning of each response.
    """

    text = str(value or "")

    if len(text) <= limit:
        return text

    return text[:limit] + "\n...[truncated]"


# =========================================================
# STORED AGENT RESULTS
# =========================================================

# Agent results are saved in the graph state and shown to the user.
# They are NOT shortened to the small prompt limits above: prompts
# clip them again with _clip() when they are passed to the LLM.
STORED_RESULT_LIMIT = 12000


def _store(value: Any) -> str:
    """
    Keep an agent result for display. Only very long results are cut,
    at a line break, and without a "[truncated]" marker.
    """

    text = str(value or "").strip()

    if len(text) <= STORED_RESULT_LIMIT:
        return text

    cut = text.rfind("\n", 0, STORED_RESULT_LIMIT)

    if cut < STORED_RESULT_LIMIT // 2:
        cut = STORED_RESULT_LIMIT

    return text[:cut].rstrip()


# =========================================================
# LLM HELPER
# =========================================================

def _llm_text(
    system_prompt: str,
    user_prompt: str,
) -> str:

    response = llm.invoke(
        [
            SystemMessage(
                content=system_prompt
            ),
            HumanMessage(
                content=user_prompt
            ),
        ]
    )

    return str(
        response.content
    )


# =========================================================
# JSON PARSER
# =========================================================

def _json_from_llm(
    text: str,
) -> dict[str, Any]:

    start = text.find("{")
    end = text.rfind("}")

    if start == -1 or end == -1 or end < start:
        raise ValueError(
            "The model did not return a JSON object."
        )

    return json.loads(
        text[start:end + 1]
    )


# =========================================================
# EMPTY CONSTRAINTS
# =========================================================

def _empty_constraints() -> dict[str, Any]:

    return {
        "destination": "",
        "origin": "",
        "duration": "",
        "budget": "",
        "travel_style": "",
        "special_preferences": [],
    }


# =========================================================
# SUPERVISOR + GUARDRAIL
# =========================================================

def supervisor_agent(
    state: TravelState,
):

    query = _clip(
        state["user_query"],
        1200,
    )

    llm_calls = state.get(
        "llm_calls",
        0,
    )

    # -----------------------------------------------------
    # INPUT GUARDRAIL
    # -----------------------------------------------------

    guardrail_prompt = f"""
Determine whether this request belongs to travel planning.

Valid requests include:
- destinations
- flights
- hotels
- weather
- budgets
- transportation
- sightseeing
- food
- packing
- itineraries
- travel advice

Block clearly unrelated requests and harmful or illegal instructions.

Do not block a valid travel request just because information is missing.

Return JSON only:

{{
  "allowed": true,
  "reason": ""
}}

User request:
{query}
"""

    try:

        guardrail_raw = _llm_text(
            """
You are the input guardrail for a travel-planning application.

Return strict JSON only.
""",
            guardrail_prompt,
        )

        guardrail_result = _json_from_llm(
            guardrail_raw
        )

        allowed = bool(
            guardrail_result.get(
                "allowed",
                True,
            )
        )

        guardrail_reason = str(
            guardrail_result.get(
                "reason",
                "",
            )
        ).strip()

        llm_calls += 1

    except Exception as exc:

        print(
            f"Guardrail fallback used: {exc}",
            flush=True,
        )

        allowed = True

        guardrail_reason = (
            "Guardrail validation fallback "
            "allowed the request."
        )

    # -----------------------------------------------------
    # BLOCKED REQUEST
    # -----------------------------------------------------

    if not allowed:

        reason = (
            guardrail_reason
            or
            "SafrMrtah can only help with "
            "travel-planning requests."
        )

        return {
            "guardrail_allowed": False,

            "guardrail_reason": reason,

            "selected_agents": [],

            "trip_constraints": (
                _empty_constraints()
            ),

            "supervisor_reasoning": reason,

            "final_response": reason,

            "messages": [
                AIMessage(
                    content=reason
                )
            ],

            "llm_calls": llm_calls,
        }

    # -----------------------------------------------------
    # SUPERVISOR
    # -----------------------------------------------------

    supervisor_prompt = f"""
You are the supervisor of a multi-agent travel planner.

Choose only the specialist agents required.

Available agents:

flight_agent:
Flights, airports, airlines, routes, airfare.

hotel_agent:
Hotels, accommodation, neighborhoods.

weather_agent:
Weather, climate, forecast, seasons, packing.

budget_agent:
Costs, affordability, budget feasibility.

itinerary_agent:
Creates the final integrated itinerary.
It must always be included.

Return JSON only:

{{
  "selected_agents": [
    "flight_agent",
    "hotel_agent",
    "weather_agent",
    "budget_agent",
    "itinerary_agent"
  ],
  "trip_constraints": {{
    "destination": "",
    "origin": "",
    "duration": "",
    "budget": "",
    "travel_style": "",
    "special_preferences": []
  }},
  "reasoning": ""
}}

User request:
{query}
"""

    try:

        supervisor_raw = _llm_text(
            """
You route work to travel specialist agents.

Return strict JSON only.
""",
            supervisor_prompt,
        )

        parsed = _json_from_llm(
            supervisor_raw
        )

        requested_agents = parsed.get(
            "selected_agents",
            [],
        )

        selected_agents = [
            agent
            for agent in AGENT_ORDER
            if agent in requested_agents
            and agent in KNOWN_AGENTS
        ]

        if "itinerary_agent" not in selected_agents:

            selected_agents.append(
                "itinerary_agent"
            )

        constraints = _empty_constraints()

        parsed_constraints = parsed.get(
            "trip_constraints",
            {},
        )

        if isinstance(
            parsed_constraints,
            dict,
        ):

            constraints.update(
                parsed_constraints
            )

        reasoning = str(
            parsed.get(
                "reasoning",
                "",
            )
        ).strip()

        llm_calls += 1

    except Exception as exc:

        print(
            f"Supervisor fallback used: {exc}",
            flush=True,
        )

        selected_agents = (
            AGENT_ORDER.copy()
        )

        constraints = (
            _empty_constraints()
        )

        reasoning = (
            "Supervisor parsing failed. "
            "The full travel workflow was selected."
        )

    return {

        "guardrail_allowed": True,

        "guardrail_reason": (
            guardrail_reason
        ),

        "selected_agents": (
            selected_agents
        ),

        "trip_constraints": (
            constraints
        ),

        "supervisor_reasoning": (
            reasoning
        ),

        "messages": [
            AIMessage(
                content=(
                    "Supervisor created "
                    "the agent plan."
                )
            )
        ],

        "llm_calls": llm_calls,
    }


# =========================================================
# GUARDRAIL BLOCKED
# =========================================================

def guardrail_blocked_agent(
    state: TravelState,
):

    reason = (
        state.get("final_response")
        or
        state.get("guardrail_reason")
        or
        "This request was blocked by the "
        "travel input guardrail."
    )

    return {
        "final_response": reason,

        "messages": [
            AIMessage(
                content=reason
            )
        ],
    }


# =========================================================
# FLIGHT HELPERS
# =========================================================

def _extract_date(
    query: str,
) -> str | None:

    """
    Extract YYYY-MM-DD from the user query.
    """

    match = re.search(
        r"\b(20\d{2}-\d{2}-\d{2})\b",
        query,
    )

    if match:
        return match.group(1)

    return None


def _extract_iata_codes(
    text: str,
) -> list[str]:

    """
    Extract likely IATA airport codes
    from Tavily results.
    """

    matches = re.findall(
        r"\b[A-Z]{3}\b",
        text or "",
    )

    excluded = {
        "THE",
        "AND",
        "FOR",
        "FROM",
        "WITH",
        "AIR",
        "USA",
        "CAN",
        "ARE",
        "NOT",
        "YOU",
        "NEW",
        "CITY",
        "AIRPORT",
    }

    codes = []

    for code in matches:

        if (
            code not in excluded
            and code not in codes
        ):
            codes.append(code)

    return codes


def _resolve_airports_with_tavily(
    query: str,
) -> tuple[str | None, str | None, str]:

    """
    Resolve origin and destination airport
    IATA codes using Tavily.

    We use Tavily because the current
    AviationStack subscription does not
    allow list_airports.
    """

    search_query = f"""
Identify the airport IATA codes for this travel request.

User request:
{query}

Identify:

1. Departure/origin airport
2. Destination/arrival airport

Focus on reliable airport information.

For each airport, clearly show:

CITY - AIRPORT NAME - IATA CODE
"""

    tavily_result = asyncio.run(
        tavily_mcp_search(
            search_query
        )
    )

    tavily_text = _clip(
        tavily_result,
        3000,
    )

    print(
        "\nTAVILY AIRPORT RESOLUTION:",
        tavily_text,
        flush=True,
    )

    codes = _extract_iata_codes(
        tavily_text
    )

    origin_iata = (
        codes[0]
        if len(codes) >= 1
        else None
    )

    destination_iata = (
        codes[1]
        if len(codes) >= 2
        else None
    )

    return (
        origin_iata,
        destination_iata,
        tavily_text,
    )


# =========================================================
# FLIGHT AGENT
# =========================================================

def flight_agent(
    state: TravelState,
):

    print(
        "\nINSIDE FLIGHT AGENT\n",
        flush=True,
    )

    query = state["user_query"]

    try:

        # -------------------------------------------------
        # 1. Resolve airports with Tavily
        # -------------------------------------------------

        (
            origin_iata,
            destination_iata,
            airport_resolution,
        ) = _resolve_airports_with_tavily(
            query
        )

        print(
            f"\nORIGIN IATA: {origin_iata}",
            flush=True,
        )

        print(
            f"DESTINATION IATA: {destination_iata}",
            flush=True,
        )

        # -------------------------------------------------
        # 2. Check airport resolution
        # -------------------------------------------------

        if (
            not origin_iata
            or not destination_iata
        ):

            flight_data = (
                "Unable to reliably determine "
                "the departure and destination "
                "airport IATA codes."
            )

        else:

            # -------------------------------------------------
            # 3. Extract travel date
            # -------------------------------------------------

            travel_date = _extract_date(
                query
            )

            print(
                f"TRAVEL DATE: {travel_date}",
                flush=True,
            )

            # -------------------------------------------------
            # 4. Departure flights
            # -------------------------------------------------

            departure_args = {
                "airport_iata_code": (
                    origin_iata
                ),
                "schedule_type": (
                    "departure"
                ),
                "number_of_flights": 10,
            }

            if travel_date:

                departure_args[
                    "date"
                ] = travel_date

            departure_result = asyncio.run(
                aviation_mcp_call(
                    "future_flights_arrival_departure_schedule",
                    departure_args,
                )
            )

            # -------------------------------------------------
            # 5. Arrival flights
            # -------------------------------------------------

            arrival_args = {
                "airport_iata_code": (
                    destination_iata
                ),
                "schedule_type": (
                    "arrival"
                ),
                "number_of_flights": 10,
            }

            if travel_date:

                arrival_args[
                    "date"
                ] = travel_date

            arrival_result = asyncio.run(
                aviation_mcp_call(
                    "future_flights_arrival_departure_schedule",
                    arrival_args,
                )
            )

            print(
                "\nDEPARTURE FLIGHTS:",
                departure_result,
                flush=True,
            )

            print(
                "\nARRIVAL FLIGHTS:",
                arrival_result,
                flush=True,
            )

            # -------------------------------------------------
            # 6. Clip MCP data
            # -------------------------------------------------

            departure_data = _clip(
                departure_result,
                2500,
            )

            arrival_data = _clip(
                arrival_result,
                2500,
            )

            # -------------------------------------------------
            # 7. Groq flight analysis
            # -------------------------------------------------

            prompt = f"""
You are a travel flight expert.

User request:
{_clip(query, 1000)}

Resolved departure airport:
{origin_iata}

Resolved destination airport:
{destination_iata}

Travel date:
{travel_date or "Not specified"}

Airport resolution:
{_clip(airport_resolution, 1000)}

Departure flight information:
{departure_data}

Arrival flight information:
{arrival_data}

Provide concise useful flight guidance.

Include:

1. Departure airport
2. Destination airport
3. Airlines if available
4. Available/relevant flight information
5. Typical flight duration if available
6. Estimated airfare guidance if available
7. Important limitations
8. Booking advice

IMPORTANT:

- Do not invent exact prices.
- Do not invent flight numbers.
- Clearly distinguish live AviationStack information
  from general travel estimates.
- If the API data does not prove a specific route,
  explicitly say so.
"""

            response = llm.invoke(
                [
                    SystemMessage(
                        content=(
                            "You are an expert "
                            "travel flight planner."
                        )
                    ),
                    HumanMessage(
                        content=prompt
                    ),
                ]
            )

            flight_data = str(
                response.content
            )

    except Exception as exc:

        print(
            f"FLIGHT AGENT ERROR: "
            f"{type(exc).__name__}: {exc}",
            flush=True,
        )

        flight_data = (
            "Flight information is temporarily "
            f"unavailable: {exc}"
        )

    return {

        "flight_results": _store(
            flight_data
        ),

        "messages": [
            AIMessage(
                content=(
                    "Flight recommendations "
                    "generated."
                )
            )
        ],

        "llm_calls": (
            state.get(
                "llm_calls",
                0,
            ) + 1
        ),
    }


# =========================================================
# HOTEL AGENT
# =========================================================

def hotel_agent(
    state: TravelState,
):

    query = (
        "Best hotels for "
        + _clip(
            state["user_query"],
            1000,
        )
    )

    try:

        hotel_results = asyncio.run(
            tavily_mcp_search(
                query
            )
        )

    except Exception as exc:

        print(
            f"HOTEL AGENT MCP ERROR: "
            f"{type(exc).__name__}: {exc}",
            flush=True,
        )

        hotel_results = (
            "Live hotel search is temporarily "
            "unavailable. Provide general "
            "accommodation and neighborhood "
            "guidance based on the destination."
        )

    hotel_results = _store(
        hotel_results
    )

    return {

        "hotel_results": (
            hotel_results
        ),

        "messages": [
            AIMessage(
                content=(
                    "Hotel information processed."
                )
            )
        ],
    }


# =========================================================
# WEATHER AGENT
# =========================================================

def weather_agent(
    state: TravelState,
):

    # Prefer the destination the Supervisor already extracted
    # (e.g. "Dubai"); fall back to the regex extractor only if empty.
    constraints = state.get("trip_constraints") or {}

    city = str(
        constraints.get("destination") or ""
    ).strip()

    try:

        if not city:
            city = extract_destination(
                state["user_query"]
            )

        weather_data = asyncio.run(
            weather_mcp_search(
                city
            )
        )

        forecast_data = asyncio.run(
            forecast_mcp_search(
                city
            )
        )

        weather_results = f"""
Current Weather:
{_clip(weather_data, 1000)}

Forecast:
{_clip(forecast_data, 1200)}
"""

    except Exception as exc:

        print(
            f"WEATHER AGENT MCP ERROR: "
            f"{type(exc).__name__}: {exc}",
            flush=True,
        )

        weather_results = (
            f"Live weather information for "
            f"{city or 'the destination'} is temporarily unavailable "
            f"({_clip(exc, 200)}). "
            "Give general seasonal guidance and "
            "recommend checking the forecast "
            "before departure."
        )

    weather_results = _store(
        weather_results
    )

    return {

        "weather_results": (
            weather_results
        ),

        "messages": [
            AIMessage(
                content=(
                    "Weather information processed."
                )
            )
        ],
    }


# =========================================================
# BUDGET AGENT
# =========================================================

def budget_agent(
    state: TravelState,
):

    prompt = f"""
Analyze whether this trip is realistic for the user's budget.

User Query:
{_clip(state.get("user_query", ""), 1000)}

Trip Constraints:
{_clip(state.get("trip_constraints", {}), 700)}

Flight Results:
{_clip(state.get("flight_results", ""), 1200)}

Hotel Results:
{_clip(state.get("hotel_results", ""), 1400)}

Weather Results:
{_clip(state.get("weather_results", ""), 1000)}

Return:

1. Estimated cost categories
2. Budget risk areas
3. Money-saving suggestions
4. Overall feasibility

If exact live prices are unavailable,
clearly label estimates as approximate.
"""

    response = llm.invoke(
        [
            SystemMessage(
                content=(
                    "You are a practical "
                    "travel budget analyst."
                )
            ),
            HumanMessage(
                content=prompt
            ),
        ]
    )

    return {

        "budget_results": _store(
            response.content
        ),

        "messages": [
            AIMessage(
                content=(
                    "Budget assessment generated."
                )
            )
        ],

        "llm_calls": (
            state.get(
                "llm_calls",
                0,
            ) + 1
        ),
    }


# =========================================================
# ITINERARY AGENT
# =========================================================

def itinerary_agent(
    state: TravelState,
):

    prompt = f"""
Create a complete travel itinerary.

User Query:
{_clip(state.get("user_query", ""), 1200)}

Trip Constraints:
{_clip(state.get("trip_constraints", {}), 800)}

Flight Results:
{_clip(state.get("flight_results", ""), 1200)}

Hotel Results:
{_clip(state.get("hotel_results", ""), 1500)}

Weather Results:
{_clip(state.get("weather_results", ""), 1200)}

Budget Results:
{_clip(state.get("budget_results", ""), 1400)}

Create a practical, budget-aware itinerary.

Include:

- Trip summary
- Transportation
- Accommodation
- Weather considerations
- Day-by-day activities
- Estimated budget
- Practical recommendations

Clearly distinguish estimates from live information.

Create a draft ready for human review.
"""

    response = llm.invoke(
        [
            SystemMessage(
                content=(
                    "You are an expert "
                    "travel planner."
                )
            ),
            HumanMessage(
                content=prompt
            ),
        ]
    )

    itinerary = str(
        response.content
    )

    approval_request = (
        "Please review the generated draft itinerary. "
        "Approve it to finalize the plan, or provide "
        "feedback for revision."
    )

    return {

        "itinerary": itinerary,

        "approval_request": (
            approval_request
        ),

        "messages": [
            AIMessage(
                content=(
                    "Draft itinerary created "
                    "for human review."
                )
            )
        ],

        "llm_calls": (
            state.get(
                "llm_calls",
                0,
            ) + 1
        ),
    }


# =========================================================
# HUMAN-IN-THE-LOOP
# =========================================================

def human_approval_agent(
    state: TravelState,
):

    review = interrupt(
        {
            "question": (
                "Do you approve this itinerary?"
            ),

            "draft_itinerary": (
                state.get(
                    "itinerary",
                    "",
                )
            ),

            "approval_request": (
                state.get(
                    "approval_request",
                    "",
                )
            ),

            "selected_agents": (
                state.get(
                    "selected_agents",
                    [],
                )
            ),

            "supervisor_reasoning": (
                state.get(
                    "supervisor_reasoning",
                    "",
                )
            ),

            "expected_response": {
                "approved": True,
                "feedback": (
                    "Optional revision feedback"
                ),
            },
        }
    )

    approved = bool(
        review.get(
            "approved",
            False,
        )
    )

    human_feedback = str(
        review.get(
            "feedback",
            "",
        )
    ).strip()

    return {

        "approved": approved,

        "human_feedback": (
            human_feedback
        ),

        "messages": [
            AIMessage(
                content=(
                    "Human approval step completed."
                )
            )
        ],
    }


# =========================================================
# FINAL AGENT
# =========================================================

def final_agent(
    state: TravelState,
):

    draft = state.get(
        "itinerary",
        "",
    )

    approved = state.get(
        "approved",
        False,
    )

    feedback = state.get(
        "human_feedback",
        "",
    ).strip()

    # -----------------------------------------------------
    # APPROVED
    # -----------------------------------------------------

    if approved:

        final_response = draft

        return {

            "final_response": (
                final_response
            ),

            "messages": [
                AIMessage(
                    content=final_response
                )
            ],
        }

    # -----------------------------------------------------
    # REJECTED WITHOUT FEEDBACK
    # -----------------------------------------------------

    if not feedback:

        final_response = draft

        return {

            "final_response": (
                final_response
            ),

            "messages": [
                AIMessage(
                    content=final_response
                )
            ],
        }

    # -----------------------------------------------------
    # REJECTED WITH FEEDBACK
    # -----------------------------------------------------

    revision_prompt = f"""
Revise the travel itinerary below according to
the human feedback.

Do not rebuild the entire travel analysis.

Keep useful information from the existing draft.

DRAFT:
{_clip(draft, 4000)}

HUMAN FEEDBACK:
{_clip(feedback, 1000)}

Return only the revised travel itinerary.
"""

    try:

        response = llm.invoke(
            [
                SystemMessage(
                    content=(
                        "You are a travel itinerary "
                        "revision assistant."
                    )
                ),
                HumanMessage(
                    content=revision_prompt
                ),
            ]
        )

        final_response = str(
            response.content
        )

        llm_calls = (
            state.get(
                "llm_calls",
                0,
            ) + 1
        )

    except Exception as exc:

        print(
            f"Revision LLM error: {exc}",
            flush=True,
        )

        final_response = draft

        llm_calls = state.get(
            "llm_calls",
            0,
        )

    return {

        "final_response": (
            final_response
        ),

        "messages": [
            AIMessage(
                content=final_response
            )
        ],

        "llm_calls": llm_calls,
    }


# =========================================================
# ROUTING
# =========================================================

ROUTE_MAP = {

    "guardrail_blocked":
        "guardrail_blocked",

    "flight_agent":
        "flight_agent",

    "hotel_agent":
        "hotel_agent",

    "weather_agent":
        "weather_agent",

    "budget_agent":
        "budget_agent",

    "itinerary_agent":
        "itinerary_agent",
}


def _selected_agents(
    state: TravelState,
) -> list[str]:

    selected = state.get(
        "selected_agents",
        [],
    )

    return [
        agent
        for agent in AGENT_ORDER
        if agent in selected
    ]


def route_from_supervisor(
    state: TravelState,
) -> str:

    if not state.get(
        "guardrail_allowed",
        True,
    ):

        return "guardrail_blocked"

    selected = _selected_agents(
        state
    )

    if selected:

        return selected[0]

    return "itinerary_agent"


def route_after_agent(
    current_agent: str,
):

    def route(
        state: TravelState,
    ) -> str:

        selected = _selected_agents(
            state
        )

        current_index = AGENT_ORDER.index(
            current_agent
        )

        for next_agent in AGENT_ORDER[
            current_index + 1:
        ]:

            if next_agent in selected:

                return next_agent

        return "itinerary_agent"

    return route


# =========================================================
# BUILD GRAPH
# =========================================================

graph = StateGraph(
    TravelState
)


graph.add_node(
    "supervisor",
    supervisor_agent,
)

graph.add_node(
    "guardrail_blocked",
    guardrail_blocked_agent,
)

graph.add_node(
    "flight_agent",
    flight_agent,
)

graph.add_node(
    "hotel_agent",
    hotel_agent,
)

graph.add_node(
    "weather_agent",
    weather_agent,
)

graph.add_node(
    "budget_agent",
    budget_agent,
)

graph.add_node(
    "itinerary_agent",
    itinerary_agent,
)

graph.add_node(
    "human_approval",
    human_approval_agent,
)

graph.add_node(
    "final_agent",
    final_agent,
)


# =========================================================
# GRAPH EDGES
# =========================================================

graph.add_edge(
    START,
    "supervisor",
)


graph.add_conditional_edges(
    "supervisor",
    route_from_supervisor,
    ROUTE_MAP,
)


graph.add_conditional_edges(
    "flight_agent",
    route_after_agent(
        "flight_agent"
    ),
    ROUTE_MAP,
)


graph.add_conditional_edges(
    "hotel_agent",
    route_after_agent(
        "hotel_agent"
    ),
    ROUTE_MAP,
)


graph.add_conditional_edges(
    "weather_agent",
    route_after_agent(
        "weather_agent"
    ),
    ROUTE_MAP,
)


graph.add_conditional_edges(
    "budget_agent",
    route_after_agent(
        "budget_agent"
    ),
    ROUTE_MAP,
)


graph.add_edge(
    "itinerary_agent",
    "human_approval",
)


graph.add_edge(
    "human_approval",
    "final_agent",
)


graph.add_edge(
    "final_agent",
    END,
)


graph.add_edge(
    "guardrail_blocked",
    END,
)


# =========================================================
# POSTGRESQL CHECKPOINTER
# =========================================================

DATABASE_URL = get_database_url()


_conn = psycopg.connect(
    DATABASE_URL,
    autocommit=True,
    row_factory=dict_row,
)


checkpointer = PostgresSaver(
    _conn
)


checkpointer.setup()


travel_graph = graph.compile(
    checkpointer=checkpointer
)


# =========================================================
# INTERRUPT HELPER
# =========================================================

def _interrupt_payload(
    result: dict[str, Any],
) -> dict[str, Any] | None:

    interrupts = result.get(
        "__interrupt__",
        [],
    )

    if not interrupts:

        return None

    first_interrupt = interrupts[0]

    payload = getattr(
        first_interrupt,
        "value",
        first_interrupt,
    )

    if isinstance(
        payload,
        dict,
    ):

        return payload

    return {
        "value": payload
    }


# =========================================================
# SERIALIZATION
# =========================================================

def _serialize_result(
    result: dict[str, Any],
    thread_id: str,
) -> dict[str, Any]:

    messages = result.get(
        "messages",
        [],
    )

    last_message = (
        messages[-1].content
        if messages
        else ""
    )

    answer = (
        result.get(
            "final_response"
        )
        or last_message
    )

    interrupt_payload = (
        _interrupt_payload(
            result
        )
    )

    if interrupt_payload:

        answer = (
            interrupt_payload.get(
                "draft_itinerary",
                "",
            )
            or result.get(
                "itinerary",
                "",
            )
        )

    return {

        "thread_id": thread_id,

        "answer": answer,

        "requires_approval": (
            interrupt_payload is not None
        ),

        "approval_request": (
            interrupt_payload.get(
                "approval_request",
                "",
            )
            if interrupt_payload
            else
            result.get(
                "approval_request",
                "",
            )
        ),

        "flight_results": (
            result.get(
                "flight_results",
                "",
            )
        ),

        "hotel_results": (
            result.get(
                "hotel_results",
                "",
            )
        ),

        "weather_results": (
            result.get(
                "weather_results",
                "",
            )
        ),

        "budget_results": (
            result.get(
                "budget_results",
                "",
            )
        ),

        "itinerary": (
            interrupt_payload.get(
                "draft_itinerary",
                "",
            )
            if interrupt_payload
            else
            result.get(
                "itinerary",
                "",
            )
        ),

        "selected_agents": (
            result.get(
                "selected_agents",
                [],
            )
        ),

        "trip_constraints": (
            result.get(
                "trip_constraints",
                {},
            )
        ),

        "supervisor_reasoning": (
            result.get(
                "supervisor_reasoning",
                "",
            )
        ),

        "guardrail_allowed": (
            result.get(
                "guardrail_allowed",
                True,
            )
        ),

        "guardrail_reason": (
            result.get(
                "guardrail_reason",
                "",
            )
        ),

        "approved": (
            result.get(
                "approved"
            )
        ),

        "human_feedback": (
            result.get(
                "human_feedback",
                "",
            )
        ),

        "llm_calls": (
            result.get(
                "llm_calls",
                0,
            )
        ),
    }


# =========================================================
# START TRAVEL AGENT
# =========================================================

def run_travel_agent(
    user_input: str,
    thread_id: str | None = None,
):

    """
    Start a new travel-planning run.

    The graph pauses at the HITL approval step.
    """

    if not thread_id:

        thread_id = (
            f"user_{uuid.uuid4().hex}"
        )

    config = {
        "configurable": {
            "thread_id": thread_id
        }
    }

    result = travel_graph.invoke(

        {
            "messages": [
                HumanMessage(
                    content=user_input
                )
            ],

            "user_query": user_input,

            "guardrail_allowed": True,

            "guardrail_reason": "",

            "selected_agents": [],

            "trip_constraints": (
                _empty_constraints()
            ),

            "supervisor_reasoning": "",

            "flight_results": "",

            "hotel_results": "",

            "weather_results": "",

            "budget_results": "",

            "itinerary": "",

            "approval_request": "",

            "approved": False,

            "human_feedback": "",

            "final_response": "",

            "llm_calls": 0,
        },

        config=config,
    )

    return _serialize_result(
        result,
        thread_id,
    )


# =========================================================
# RESUME AFTER HUMAN APPROVAL
# =========================================================

def resume_travel_agent(
    thread_id: str,
    approved: bool,
    feedback: str = "",
):

    """
    Resume the paused LangGraph thread
    after human review.
    """

    if not thread_id:

        raise ValueError(
            "thread_id is required "
            "to resume a travel plan."
        )

    config = {
        "configurable": {
            "thread_id": thread_id
        }
    }

    result = travel_graph.invoke(

        Command(
            resume={
                "approved": approved,
                "feedback": feedback.strip(),
            }
        ),

        config=config,
    )

    return _serialize_result(
        result,
        thread_id,
    )

# =========================================================
# SESSION RETRIEVAL (read-only, used by the dashboard)
# =========================================================
#
# The PostgreSQL checkpointer already stores every thread.
# These helpers only READ that state so the frontend can
# rebuild its "Travel Sessions" list after a browser
# refresh or a server restart. They do not change the graph.

def _session_status(
    values: dict[str, Any],
    has_interrupt: bool,
) -> str:

    if values.get("guardrail_allowed") is False:
        return "blocked"

    if has_interrupt:
        return "draft"

    if values.get("final_response"):

        if values.get("approved"):
            return "finalized"

        if values.get("human_feedback"):
            return "revised"

        return "completed"

    return "incomplete"


def _thread_snapshot(
    thread_id: str,
):

    config = {
        "configurable": {
            "thread_id": thread_id
        }
    }

    snapshot = travel_graph.get_state(
        config
    )

    if snapshot is None or not snapshot.values:
        return None, None

    values = dict(
        snapshot.values
    )

    # Pending HITL interrupt(s) live on the next task(s).
    interrupts = []

    for task in (snapshot.tasks or ()):
        interrupts.extend(
            getattr(task, "interrupts", ()) or ()
        )

    if interrupts:
        values["__interrupt__"] = interrupts

    return snapshot, values


def get_travel_session(
    thread_id: str,
) -> dict[str, Any] | None:

    """
    Return the latest state of one travel thread in the
    same shape as /api/travel, plus user_query / status.
    """

    snapshot, values = _thread_snapshot(
        thread_id
    )

    if values is None:
        return None

    has_interrupt = "__interrupt__" in values

    data = _serialize_result(
        values,
        thread_id,
    )

    data["user_query"] = values.get(
        "user_query",
        "",
    )

    data["status"] = _session_status(
        values,
        has_interrupt,
    )

    data["updated_at"] = getattr(
        snapshot,
        "created_at",
        None,
    )

    return data


def list_travel_sessions(
    limit: int = 30,
) -> list[dict[str, Any]]:

    """
    List recent travel threads stored by the checkpointer.

    NOTE: there is no user authentication in this app, so
    this returns every thread in the database. Scope it by
    user before exposing the app to multiple users.
    """

    limit = max(
        1,
        min(int(limit), 100),
    )

    queries = [
        # Preferred: real timestamps from the checkpoint JSON.
        """
        SELECT thread_id,
               MIN(checkpoint ->> 'ts') AS created_at,
               MAX(checkpoint ->> 'ts') AS updated_at
        FROM checkpoints
        WHERE checkpoint_ns = ''
          AND LEFT(thread_id, 5) = 'user_'
        GROUP BY thread_id
        ORDER BY MAX(checkpoint ->> 'ts') DESC
        LIMIT %s
        """,
        # Fallback: checkpoint ids are time-ordered (uuid6).
        """
        SELECT thread_id,
               NULL AS created_at,
               NULL AS updated_at
        FROM checkpoints
        WHERE checkpoint_ns = ''
          AND LEFT(thread_id, 5) = 'user_'
        GROUP BY thread_id
        ORDER BY MAX(checkpoint_id) DESC
        LIMIT %s
        """,
    ]

    rows = []

    for query in queries:

        try:

            with _conn.cursor() as cur:
                cur.execute(query, (limit,))
                rows = cur.fetchall()

            break

        except Exception as exc:

            print(
                f"Session list query failed: {exc}",
                flush=True,
            )

            rows = []

    sessions = []

    for row in rows:

        thread_id = row["thread_id"]

        try:

            snapshot, values = _thread_snapshot(
                thread_id
            )

        except Exception as exc:

            print(
                f"Could not load thread {thread_id}: {exc}",
                flush=True,
            )

            continue

        if values is None:
            continue

        sessions.append(
            {
                "thread_id": thread_id,

                "user_query": values.get(
                    "user_query",
                    "",
                ),

                "trip_constraints": (
                    values.get("trip_constraints")
                    or {}
                ),

                "selected_agents": (
                    values.get("selected_agents")
                    or []
                ),

                "status": _session_status(
                    values,
                    "__interrupt__" in values,
                ),

                "created_at": row.get("created_at"),

                "updated_at": (
                    row.get("updated_at")
                    or getattr(snapshot, "created_at", None)
                ),
            }
        )

    return sessions
