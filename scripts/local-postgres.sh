#!/usr/bin/env bash
# Start a throw-away PostgreSQL on port 55432 using the PostgreSQL binaries already installed on this computer
# (no Docker needed). Data lives in $PALTAS_PG_DIR (default /var/tmp/paltas-pg). Local development and tests only.
#   scripts/local-postgres.sh start | stop | status
set -euo pipefail
DIR="${PALTAS_PG_DIR:-/var/tmp/paltas-pg}"
BIN="$(dirname "$(command -v pg_ctl || ls /usr/lib/postgresql/*/bin/pg_ctl | tail -1)")"
RUN_AS=()
if [ "$(id -u)" = "0" ]; then RUN_AS=(su postgres -c); fi
run() { if [ ${#RUN_AS[@]} -gt 0 ]; then "${RUN_AS[@]}" "$*"; else bash -c "$*"; fi; }
case "${1:-start}" in
  start)
    if [ ! -f "$DIR/PG_VERSION" ]; then
      mkdir -p "$DIR"; [ "$(id -u)" = "0" ] && chown postgres "$DIR"
      run "$BIN/initdb -D $DIR -U paltas --auth=trust -E UTF8 >/dev/null"
    fi
    run "$BIN/pg_ctl -D $DIR -o '-p 55432 -k /tmp' -l $DIR/log.txt start"
    echo "PostgreSQL on 127.0.0.1:55432 (user paltas, no password — local only)"
    echo "  DATABASE_URL=postgres://paltas@127.0.0.1:55432/paltas   (createdb -h 127.0.0.1 -p 55432 -U paltas paltas)"
    echo "  PALTAS_TEST_PG=postgres://paltas@127.0.0.1:55432/postgres" ;;
  stop) run "$BIN/pg_ctl -D $DIR stop" ;;
  status) run "$BIN/pg_ctl -D $DIR status" ;;
  *) echo "usage: $0 start|stop|status"; exit 2 ;;
esac
