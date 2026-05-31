#!/bin/sh
set -e
echo "[entry] PORT=${PORT:-3457} HOST=${HOST:-0.0.0.0} DATA_DIR=${DATA_DIR:-/app}"
exec node markets-server.mjs
