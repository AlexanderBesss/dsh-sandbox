#!/bin/sh

op=$1
cwd=$2
shift 2

pidfile=/tmp/.dsh-pid-$op

if [ "$cwd" != "-" ]; then
  cd "$cwd" 2>/dev/null || {
    printf 'dsh-docker-sandbox: cannot change directory to %s\n' "$cwd" >&2
    exit 64
  }
fi

if command -v setsid >/dev/null 2>&1; then
  setsid sh -c 'echo "$$" > "$1" 2>/dev/null; shift; exec "$@"' sh "$pidfile" "$@"
else
  sh -c 'echo "$$" > "$1" 2>/dev/null; shift; exec "$@"' sh "$pidfile" "$@"
fi
