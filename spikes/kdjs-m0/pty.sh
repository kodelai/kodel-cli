#!/bin/sh
# M0 driver: Q3 (WKJ4-shaped step, owner SIGKILLed after start, retry joins, one result) and Q5/Q2 checks.
set -u
cd "$(dirname "$0")"
export KODEL_SPIKE_DIR="${TMPDIR:-/tmp}/kdjs-m0-$$"; mkdir -p "$KODEL_SPIKE_DIR"
# needs unix sockets and a PTY (blocked in the Claude sandbox)
echo "base: $KODEL_SPIKE_DIR"
C="$KODEL_SPIKE_DIR/counter"
echo "--- Q2/Q1: PTY holder, scripted attach over the socket"
node spike.mjs start pt pty -- sh -c 'read x; echo got:$x; sleep 1'
for i in 1 2 3 4 5 6 7 8 9 10; do [ -S "$KODEL_SPIKE_DIR/run/pt/s.sock" ] && break; sleep 0.2; done # finding: ready is written before the PTY owner binds
printf 'hello\n' | node -e '
const net=require("net");const fs=require("fs");
const st=JSON.parse(fs.readFileSync(process.env.KODEL_SPIKE_DIR+"/run/pt/status.json"));
const s=net.connect(st.sock);let out="";s.on("data",d=>out+=d);
setTimeout(()=>s.write("hello\n"),300);setTimeout(()=>{console.log("attach saw:",JSON.stringify(out));process.exit(0)},1500)'
node spike.mjs wait pt
echo "--- re-attach after exit keeps ring? tail:"
node spike.mjs tail pt | od -c | head -3
