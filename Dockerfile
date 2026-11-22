# SafrMrtah - production image
FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    # uv installs the AviationStack MCP tool (and the Python 3.13 it needs)
    # into shared folders so the non-root user below can run it.
    UV_TOOL_DIR=/opt/uv/tools \
    UV_TOOL_BIN_DIR=/usr/local/bin \
    UV_PYTHON_INSTALL_DIR=/opt/uv/python \
    UV_CACHE_DIR=/tmp/uv-cache

WORKDIR /app

COPY requirements.txt .
RUN pip install -r requirements.txt

# Install the flight-data MCP server at build time, not on the first request.
RUN uv tool install aviationstack-mcp \
    && test -x /usr/local/bin/aviationstack-mcp \
    && rm -rf /tmp/uv-cache

# Run as an unprivileged user.
RUN useradd --create-home --uid 10001 app
COPY --chown=app:app . .
USER app

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD python -c "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:%s/health' % os.environ.get('PORT','8000'), timeout=4)" || exit 1

# Hosting platforms (Render, Railway, Fly...) pass the port in $PORT.
CMD ["sh", "-c", "exec uvicorn app:app --host 0.0.0.0 --port ${PORT:-8000} --proxy-headers --forwarded-allow-ips='*'"]
