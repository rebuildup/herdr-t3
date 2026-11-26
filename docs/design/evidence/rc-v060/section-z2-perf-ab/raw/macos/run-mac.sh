#!/bin/bash
set -u
OUT=/tmp/ht3-ab/results
ARMS="0e3c14e 932ce11 2febbbf 9bb50cf"
LOG=$OUT/runner.log
log(){ echo "$(date -u +%FT%TZ) $1" | tee -a $LOG; }
dir_for(){ case "$1" in 0e3c14e) echo /tmp/ht3-ab/0e3c14e;; 932ce11) echo /tmp/ht3-ab/932ce11;; 2febbbf) echo /tmp/ht3-ab/2febbbf;; 9bb50cf) echo /tmp/ht3-ab/9bb50cf;; esac; }
python3 /tmp/ht3-ab/sampler.py $OUT/cpu-samples.csv & SAMPLER=$!
log "sampler pid=$SAMPLER"
LOADPIDS=""
start_load(){ for i in $(seq 1 10); do bash -c 'while :; do :; done' & LOADPIDS="$LOADPIDS $!"; done; log "load started: 10 spinners"; }
stop_load(){ for p in $LOADPIDS; do kill $p 2>/dev/null; done; LOADPIDS=""; log "load stopped"; sleep 3; }
set -- $ARMS; N=$#
for cond in idle loaded; do
  [ "$cond" = loaded ] && start_load
  for r in 1 2 3 4 5; do
    for i in $(seq 0 $((N-1))); do
      idx=$(( (i + r - 1) % N ))
      arm=$(eval "echo \${$((idx+1))}")
      tag="$arm-$cond-r$r"
      ( cd "$(dir_for $arm)" && bun scripts/perf-baseline.ts record --iterations 5 --out "$OUT/$tag.json" ) > "$OUT/$tag.log" 2>&1
      log "record $tag rc=$? -> $OUT/$tag.json"
      sleep 2
    done
  done
  [ "$cond" = loaded ] && stop_load
done
kill $SAMPLER 2>/dev/null
log "done"
