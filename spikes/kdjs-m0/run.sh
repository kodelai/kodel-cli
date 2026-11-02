#!/bin/sh
# M0 driver: Q3 (WKJ4-shaped step, owner SIGKILLed after start, retry joins, one result) and Q5/Q2 checks.
set -u
cd "$(dirname "$0")"
export KODEL_SPIKE_DIR="${TMPDIR:-/tmp}/kdjs-m0-$$"; mkdir -p "$KODEL_SPIKE_DIR"
echo "base: $KODEL_SPIKE_DIR"
C="$KODEL_SPIKE_DIR/counter"
echo "--- Q3: owner dies after start"
SPIKE_DIE_AFTER_START=1 node step.mjs run1 nodeA 1 sh -c "sleep 2; echo x >> $C"
echo "owner exit: $? (expected 137 = SIGKILL)"
echo "--- retry"
node step.mjs run1 nodeA 1 sh -c "sleep 2; echo x >> $C"
echo "child ran $(wc -l < "$C") time(s) (expected 1)"
echo "--- Q5: holder survives intermediate and starter exit; ppid"
N=$(node spike.mjs ls | head -1 | cut -d' ' -f1)
node spike.mjs status "$N"
echo "--- Q3b: stop"
node spike.mjs start sl pipes -- sleep 600
node spike.mjs stop sl; sleep 1; node spike.mjs status sl
