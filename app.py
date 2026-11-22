from pathlib import Path
import base64
import os
import secrets
import traceback

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel, Field

from backend import (
    run_travel_agent,
    resume_travel_agent,
    get_travel_session,
    list_travel_sessions,
)

# This is kept from the original project to allow the existing synchronous
# agent functions to call async MCP helpers inside FastAPI.
import nest_asyncio

nest_asyncio.apply()

BASE_DIR = Path(__file__).resolve().parent

app = FastAPI(
    title="SafrMrtah",
    description=(
        "LangGraph Multi-Agent Travel Planner with Supervisor, Guardrails, "
        "Human-in-the-Loop, and FastAPI Frontend"
    ),
    version="2.0.0",
)

# ---------------------------------------------------------
# Password protection
# ---------------------------------------------------------
# Set APP_PASSWORD (and optionally APP_USERNAME, default "admin") on the
# server. Visitors are then asked to sign in once by their browser.
# Leave APP_PASSWORD empty on your own computer to keep the site open.

APP_USERNAME = (os.getenv("APP_USERNAME") or "admin").strip()
APP_PASSWORD = os.getenv("APP_PASSWORD") or ""

# Reachable without signing in, so the host can check the app is running.
PUBLIC_PATHS = {"/health", "/favicon.ico"}

if not APP_PASSWORD:
    print(
        "WARNING: APP_PASSWORD is not set - anyone who can reach this "
        "server can use it and your API quotas.",
        flush=True,
    )


def _credentials_ok(header: str) -> bool:
    if not header.startswith("Basic "):
        return False

    try:
        decoded = base64.b64decode(header[6:], validate=True).decode("utf-8")
    except Exception:
        return False

    username, _, password = decoded.partition(":")

    # compare_digest on both, so timing does not reveal which part is wrong
    user_ok = secrets.compare_digest(username.encode(), APP_USERNAME.encode())
    pass_ok = secrets.compare_digest(password.encode(), APP_PASSWORD.encode())

    return user_ok and pass_ok


@app.middleware("http")
async def require_password(request: Request, call_next):
    if not APP_PASSWORD or request.url.path in PUBLIC_PATHS:
        return await call_next(request)

    if _credentials_ok(request.headers.get("authorization", "")):
        return await call_next(request)

    return Response(
        "Sign in to use SafrMrtah.",
        status_code=401,
        headers={"WWW-Authenticate": 'Basic realm="SafrMrtah", charset="UTF-8"'},
    )


app.mount(
    "/static",
    StaticFiles(directory=str(BASE_DIR / "static")),
    name="static",
)

templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))


class TravelRequest(BaseModel):
    message: str
    thread_id: str | None = None


class ApprovalRequest(BaseModel):
    thread_id: str = Field(min_length=1)
    approved: bool
    feedback: str = ""


@app.get("/", response_class=HTMLResponse)
async def home(request: Request):
    return templates.TemplateResponse(
        request=request,
        name="index.html",
        context={},
    )


@app.post("/api/travel")
async def travel_planner(request_data: TravelRequest):
    try:
        user_message = request_data.message.strip()

        if not user_message:
            return JSONResponse(
                status_code=400,
                content={
                    "success": False,
                    "error": "Message cannot be empty.",
                },
            )

        result = run_travel_agent(
            user_input=user_message,
            thread_id=request_data.thread_id,
        )

        return JSONResponse(
            content={
                "success": True,
                **result,
            }
        )

    except Exception as exc:
        print("ERROR:", exc)
        traceback.print_exc()

        return JSONResponse(
            status_code=500,
            content={
                "success": False,
                "error": str(exc),
            },
        )


@app.post("/api/travel/approve")
async def approve_travel_plan(request_data: ApprovalRequest):
    try:
        if not request_data.approved and not request_data.feedback.strip():
            return JSONResponse(
                status_code=400,
                content={
                    "success": False,
                    "error": "Please provide revision feedback when rejecting the draft.",
                },
            )

        result = resume_travel_agent(
            thread_id=request_data.thread_id,
            approved=request_data.approved,
            feedback=request_data.feedback,
        )

        return JSONResponse(
            content={
                "success": True,
                **result,
            }
        )

    except Exception as exc:
        print("APPROVAL ERROR:", exc)
        traceback.print_exc()

        return JSONResponse(
            status_code=500,
            content={
                "success": False,
                "error": str(exc),
            },
        )


# ---------------------------------------------------------
# Read-only session endpoints (dashboard history)
# ---------------------------------------------------------

@app.get("/api/travel/sessions")
async def travel_sessions(limit: int = 30):
    try:
        return JSONResponse(
            content={
                "success": True,
                "sessions": list_travel_sessions(limit),
            }
        )

    except Exception as exc:
        print("SESSION LIST ERROR:", exc)
        traceback.print_exc()

        return JSONResponse(
            status_code=500,
            content={
                "success": False,
                "error": str(exc),
            },
        )


@app.get("/api/travel/session/{thread_id}")
async def travel_session(thread_id: str):
    try:
        data = get_travel_session(thread_id)

        if data is None:
            return JSONResponse(
                status_code=404,
                content={
                    "success": False,
                    "error": "Travel session not found.",
                },
            )

        return JSONResponse(
            content={
                "success": True,
                **data,
            }
        )

    except Exception as exc:
        print("SESSION LOAD ERROR:", exc)
        traceback.print_exc()

        return JSONResponse(
            status_code=500,
            content={
                "success": False,
                "error": str(exc),
            },
        )


@app.get("/health")
async def health_check():
    return {
        "status": "ok",
        "message": "SafrMrtah API is running",
        "features": [
            "supervisor_agent",
            "input_guardrail",
            "human_in_the_loop",
        ],
    }


@app.get("/favicon.ico")
async def favicon():
    return JSONResponse(content={})


if __name__ == "__main__":
    # Local development. In production the Dockerfile starts uvicorn itself.
    uvicorn.run(
        "app:app",
        host=os.getenv("HOST", "127.0.0.1"),
        port=int(os.getenv("PORT", "8000")),
        reload=os.getenv("RELOAD", "true").lower() == "true",
    )
