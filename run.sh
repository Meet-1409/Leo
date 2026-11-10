#!/bin/sh
# Starts Leo on this computer at http://127.0.0.1:8010
cd "$(dirname "$0")" || exit 1
exec .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port "${PORT:-8010}"
