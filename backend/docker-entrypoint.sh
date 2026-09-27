#!/bin/sh
# Ensure the (possibly root-owned) mounted data volume is writable by the unprivileged "node" user,
# then run the app as "node". If the container is already started as non-root, just exec.
set -e
DATA_DIR="${DATA_DIR:-/data}"
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  chown -R node:node "$DATA_DIR"
  chmod 700 "$DATA_DIR"
  exec su-exec node "$@"
fi
exec "$@"
