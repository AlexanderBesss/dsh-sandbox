#!/bin/sh
# dsh-docker-sandbox command runner, uploaded once per sandbox container.
#
# Every command the plugin runs goes through this script so that the process
# started inside the container can be stopped later: killing the local
# `docker exec` client does not stop the remote process.
#
# usage: .dsh-run.sh <op-id> <cwd|-> <command> [args…]
#
# The command is `setsid`'d so it leads its own process group, its pid is
# recorded, and it is then exec'd in place: the exit code, stdin, and stdout of
# the exec'd program are exactly what the caller sees on the exec stream.
# BusyBox `setsid` has no `-w`, and does not need one: it calls setsid() and
# exec's the program itself, so the recorded pid is also the process group id.
# `kill -TERM -<pid>` from a second exec then stops the whole group.
#
# Without `setsid` the recorded pid is the exec'd command itself, not a group
# leader; the signaler falls back to a bare `kill <pid>` in that case, which
# stops the command but not any children it forked.

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
