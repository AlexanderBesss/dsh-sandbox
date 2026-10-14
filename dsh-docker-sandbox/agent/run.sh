#!/bin/sh
# dsh-docker-sandbox command runner, uploaded once per sandbox container.
# Every plugin command goes through here so it can be stopped later: killing the local
# `docker exec` client does not stop the remote process.
# usage: .dsh-run.sh <op-id> <cwd|-> <command> [args…]

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

# BusyBox setsid has no -w and needs none: it setsid()s and execs in place, so the recorded pid is also
# the pgid and `kill -TERM -<pid>` from a second exec stops the whole group. Without setsid the pid is
# the command itself and the signaler falls back to a bare `kill <pid>` — forked children survive that.
if command -v setsid >/dev/null 2>&1; then
  setsid sh -c 'echo "$$" > "$1" 2>/dev/null; shift; exec "$@"' sh "$pidfile" "$@"
else
  sh -c 'echo "$$" > "$1" 2>/dev/null; shift; exec "$@"' sh "$pidfile" "$@"
fi
