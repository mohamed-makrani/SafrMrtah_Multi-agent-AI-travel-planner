# Deploying SafrMrtah

## Before you push

0. **Use your own GitHub repository.** This folder was cloned from
   `entbappy/Multi-Agent-System-using-LangGraph-MCP-Supervisor-Guardrails-HITL`,
   which belongs to someone else. Create an empty repository on GitHub
   (for example `safrmrtah`, private is fine), then in the project folder:
   ```
   git remote rename origin upstream
   git remote add origin https://github.com/<your-username>/safrmrtah.git
   ```
   After the commit below, push with `git push -u origin main`.
1. Make sure these are **not** in your commit (they are ignored, but check
   `git status`): `.env`, `.venv/`, `venv.bak/`, `_ui_backup/`.
2. Commit and push to GitHub:
   ```
   git add -A
   git status        # .env must not appear in the list
   git commit -m "SafrMrtah: new interface, remote weather MCP, deploy setup"
   git push -u origin main
   ```
3. If `.env` was ever committed in the past, it is still in the git history:
   create new API keys (Groq, Tavily, AviationStack, OpenWeather) and a new
   database password, and use only the new ones.

## Moving the project to another computer

Clone your repository there, copy `.env` by hand (USB stick, password
manager - never through git), then run `setup_venv.bat` and `run_local.bat`.

## Deploy on Render (recommended)

1. Render dashboard → **New → Blueprint** → choose your repository.
   Render reads `render.yaml` and creates the web service from the `Dockerfile`.
2. Fill in the values it asks for (copy them from your local `.env`):
   `GROQ_API_KEY`, `DATABASE_URL`, `TAVILY_API_KEY`, `AVIATIONSTACK_API_KEY`,
   `OPENWEATHER_API_KEY`, and **`APP_PASSWORD`** (choose a strong one).
3. Wait for the build (a few minutes the first time), then open the URL.
   Your browser asks for a username and password: `admin` and your
   `APP_PASSWORD`.
4. Your existing trips appear, because they are stored in the same
   PostgreSQL database.

Notes
- On the **free** plan the site sleeps after about 15 minutes without
  visits; the next visit takes about a minute to wake it. Change `plan:` in
  `render.yaml` to `starter` to keep it always on.
- `/health` stays public so Render can check the service is up.
- Weather works out of the box: the app starts the weather MCP server itself.

## Deploy anywhere else with Docker

```
docker build -t safrmrtah .
docker run -p 8000:8000 --env-file .env -e APP_PASSWORD=choose-one safrmrtah
```
The container listens on `$PORT` (default 8000), runs as a non-root user and
has a built-in health check. `.env` is never copied into the image; pass it
at run time as above, or set the variables in your host's dashboard.

## Optional: run the weather MCP server as its own service

1. Create a second service from the same repository with the start command
   `python custom_weather_mcp_server.py`, and set `OPENWEATHER_API_KEY`,
   `WEATHER_MCP_HOST=0.0.0.0` and a random `WEATHER_MCP_TOKEN`.
2. On the main app, set `WEATHER_MCP_URL=https://<weather-service>/mcp` and the
   same `WEATHER_MCP_TOKEN`.
If the weather service is down, the app falls back to its built-in one.

## Security checklist

- [ ] `APP_PASSWORD` is set on the server
- [ ] `.env` is not in git (`git ls-files .env` prints nothing)
- [ ] API keys exist only in your local `.env` and the host's settings
- [ ] Anyone you give the password to can see all trips in the database
