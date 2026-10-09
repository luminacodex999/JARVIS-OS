#!/bin/bash
# Reap orphaned Claude Code processes (SG-817, LCI-359).
#
# The leak: Claude Desktop routine fires spawn `claude` process trees that are
# never reaped. When the spawner dies, the tree reparents to launchd (ppid 1)
# and sits there holding 100-200MB each, forever.
#
# Kill criteria -- ALL must hold, so this can never touch live work:
#   ppid == 1        orphaned; its spawner is already dead
#   tty  == ??       no controlling terminal, so not an interactive session
#   age  > 3.5h      well past any real routine fire (they run hourly)
#   cpu  flat        burned no measurable CPU across a full run interval
#   no TTY kin       no descendant anywhere below it holds a controlling tty
#
# Interactive sessions in a terminal tab always have a TTY and are never
# candidates, no matter how old. Closing those is a human decision.
#
# 2026-08-28: age raised 2h -> 3.5h, and the CPU-activity gate added. Age alone
# was unsafe for headless agent runs: an orphaned `claude -p` still mid-
# implementation would be killed the moment it crossed the age line, because
# nothing measured whether it was doing anything. Now each candidate's
# cumulative CPU time is recorded, and it is only reaped if that number has not
# moved since the previous run. Thirty minutes of exactly zero CPU is real
# dormancy; a working agent always burns some.
#
# Consequence, by design: a process is never reaped on the first run that sees
# it -- there is no prior sample to compare against. Real minimum lifetime is
# therefore age + one interval, about 4 hours.
#
# 2026-10-09 (LCI-359): the TTY exclusion now covers the WHOLE SUBTREE, not just
# the candidate. Claude Code's current shape runs a `claude bg-pty-host` with
# ppid 1 and no controlling tty whose `claude bg-spare` child IS on a live tty.
# The old code killed `$pid` plus `pgrep -P $pid` unconditionally, so a live
# interactive session died as a "kid" of an orphan that looked safe to reap.
# A parent cannot be killed while sparing such a child either -- the child's PTY
# master dies with it -- so the entire tree is skipped and the reason logged.
# The walk is recursive because the tty holder can be a grandchild, not a child.
#
# Every kill and skip line reports the MEASURED before/after state of the
# process. A signal call that does not throw is not evidence that anything
# happened: `kill` succeeds against a process that was already gone.
#
# Two consequences of taking that seriously, both found in review of LCI-359:
#
# 1. SIGTERM delivery is ASYNCHRONOUS. A process can still read `alive` the
#    instant after the signal is sent, so the line cannot say `reaped` yet --
#    that would be a status contradicting its own measurement. It says
#    `signaled` until an exit is actually observed, and the SIGKILL pass below
#    reports the final transition. The run tally is likewise recomputed from
#    measured state at the end, never accumulated from signals sent.
#
# 2. The subtree is re-walked IMMEDIATELY BEFORE signalling. The scan loop and
#    the kill loop are separated by every other candidate's scan, and a tree can
#    gain a tty-attached descendant inside that window; acting on the stale list
#    would kill a live PTY. The snapshot that authorises a kill has to be the
#    one taken at the moment of the kill.

set -uo pipefail

MIN_AGE_SECONDS=${MIN_AGE_SECONDS:-12600}   # 3.5h
CPU_DELTA_SECONDS=${CPU_DELTA_SECONDS:-1}   # CPU growth that counts as "working"
LOG="${HOME}/Library/Logs/claude-reaper.log"
STATE_DIR="${HOME}/Library/Application Support/claude-reaper"
STATE="${STATE_DIR}/activity.state"

mkdir -p "$(dirname "$LOG")" "$STATE_DIR"

log() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" >> "$LOG"; }

now=$(date +%s)

# [[DD-]HH:]MM:SS[.ss] -> whole seconds. Used for both etime and cputime.
to_secs() {
  printf '%s' "$1" | awk '
    { e = $0; d = 0
      if (e ~ /-/) { split(e, p, "-"); d = p[1]; e = p[2] }
      sub(/\..*$/, "", e)
      n = split(e, p, ":")
      if (n == 3)      print d * 86400 + p[1] * 3600 + p[2] * 60 + p[3]
      else if (n == 2) print d * 86400 + p[1] * 60 + p[2]
      else             print d * 86400 + p[1]
    }'
}

# Observed liveness, not the exit status of a signal.
pstate() {
  if ps -p "$1" -o pid= > /dev/null 2>&1; then printf 'alive'; else printf 'dead'; fi
}

# Controlling terminal of a pid; empty when the process is gone.
ptty() { ps -p "$1" -o tty= 2>/dev/null | tr -d ' '; }

# Every descendant of $1, breadth-first. Strings, not arrays: bash 3.2 ships on
# macOS and errors on empty-array expansion under `set -u`.
descendants() {
  local queue="$1" out="" cur kids k
  while :; do
    queue="${queue# }"
    [ -z "$queue" ] && break
    cur="${queue%% *}"
    if [ "$cur" = "$queue" ]; then queue=""; else queue="${queue#* }"; fi
    kids=$(pgrep -P "$cur" 2>/dev/null)
    for k in $kids; do
      [ -z "$k" ] && continue
      case " $out " in *" $k "*) continue ;; esac   # cycle/duplicate guard
      out="$out $k"
      queue="$queue $k"
    done
  done
  printf '%s' "${out# }"
}

# ppid 1, no tty, named claude, past the age line. The comm field carries
# arguments for `claude bg-pty-host`, so $6 is the bare program name.
candidates=$(ps -Ao pid=,ppid=,tty=,etime=,rss=,comm= \
  | awk '$2 == 1 && $3 == "??" && $6 ~ /(^|\/)claude$/ { print $1, $4, $5 }')

new_state=""
to_kill=""
all_targets=""

if [ -n "$candidates" ]; then
  while read -r pid etime rss; do
    [ -z "${pid:-}" ] && continue

    age=$(to_secs "$etime")
    [ "$age" -le "$MIN_AGE_SECONDS" ] && continue

    cputime=$(ps -o cputime= -p "$pid" 2>/dev/null | tr -d ' ')
    [ -z "$cputime" ] && continue          # exited between the two ps calls
    cpu=$(to_secs "$cputime")

    # Identify the process by pid AND start time, so a recycled pid can never
    # inherit an older process's sample.
    start=$((now - age))

    prev=$(awk -v p="$pid" -v s="$start" \
      '$1 == p && ($2 - s) <= 10 && (s - $2) <= 10 { print $3; exit }' "$STATE" 2>/dev/null)

    new_state="${new_state}${pid} ${start} ${cpu}"$'\n'

    if [ -z "$prev" ]; then
      log "observing pid=$pid age=${age}s cpu=${cpu}s rss=$((rss / 1024))MB (no prior sample -- not eligible this run)"
      continue
    fi

    if [ $((cpu - prev)) -ge "$CPU_DELTA_SECONDS" ]; then
      log "active  pid=$pid age=${age}s cpu=${prev}s->${cpu}s -- still working, leaving alone"
      continue
    fi

    # The candidate is dormant, but its subtree may hold a live terminal.
    kin=$(descendants "$pid")
    held_pid=""
    held_tty=""
    for k in $kin; do
      ktty=$(ptty "$k")
      if [ -n "$ktty" ] && [ "$ktty" != "??" ]; then
        held_pid="$k"
        held_tty="$ktty"
        break
      fi
    done

    if [ -n "$held_pid" ]; then
      log "skipped pid=$pid before=$(pstate "$pid") reason=tty-attached-descendant child=$held_pid tty=$held_tty after=$(pstate "$pid")"
      continue
    fi

    to_kill="${to_kill}${pid}|${age}|${rss}|${cpu}"$'\n'
  done <<< "$candidates"
fi

# Rewrite state from scratch so records for dead pids age out immediately.
printf '%s' "$new_state" > "$STATE"

[ -z "$to_kill" ] && exit 0

parent_rss=""
while IFS='|' read -r pid age rss cpu; do
  [ -z "${pid:-}" ] && continue

  # Re-walk the subtree HERE, not from the scan: a tty-attached descendant may
  # have appeared since, and the stale list would take a live PTY with it.
  kin=$(descendants "$pid")
  held_pid=""
  held_tty=""
  for k in $kin; do
    ktty=$(ptty "$k")
    if [ -n "$ktty" ] && [ "$ktty" != "??" ]; then
      held_pid="$k"
      held_tty="$ktty"
      break
    fi
  done

  if [ -n "$held_pid" ]; then
    log "skipped pid=$pid before=$(pstate "$pid") reason=tty-attached-descendant-appeared child=$held_pid tty=$held_tty after=$(pstate "$pid")"
    continue
  fi

  targets="$pid${kin:+ $kin}"
  all_targets="$all_targets $targets"
  parent_rss="$parent_rss $pid:$rss"

  before=$(pstate "$pid")
  kill $targets 2>/dev/null
  after=$(pstate "$pid")

  kin_after=""
  for k in $kin; do kin_after="$kin_after $k=$(pstate "$k")"; done

  if [ "$after" = "dead" ]; then
    log "reaped  pid=$pid before=$before after=$after age=${age}s cpu=${cpu}s (flat) rss=$((rss / 1024))MB kids=[${kin:-none}] kids_after=[${kin_after# }]"
  else
    log "signaled pid=$pid before=$before after=$after age=${age}s cpu=${cpu}s (flat) SIGTERM sent, exit not yet observed kids=[${kin:-none}] kids_after=[${kin_after# }]"
  fi
done <<< "$to_kill"

# Anything that ignored SIGTERM, or had not exited yet, gets SIGKILL.
sleep 5
for t in $all_targets; do
  [ -z "$t" ] && continue
  b=$(pstate "$t")
  [ "$b" = "dead" ] && continue
  kill -9 "$t" 2>/dev/null
  log "SIGKILL pid=$t before=$b after=$(pstate "$t") (did not exit on SIGTERM)"
done

# Tally from OBSERVED state, never from the number of signals sent.
freed_kb=0
count=0
for pair in $parent_rss; do
  [ -z "$pair" ] && continue
  p="${pair%%:*}"
  r="${pair##*:}"
  if [ "$(pstate "$p")" = "dead" ]; then
    count=$((count + 1))
    freed_kb=$((freed_kb + r))
  fi
done

log "run complete: reaped ${count} proc(s), ~$((freed_kb / 1024))MB"
