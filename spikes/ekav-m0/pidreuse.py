#!/usr/bin/env python3
# Criterion 10, second half: is a number in use as a process group given to a new process as its pid?
# A group is made whose leader has exited while a member lives (pgid = the dead leader's pid). Then the pid
# counter is driven around past that number twice with forks, and every pid handed out is looked at.
#   python3 pidreuse.py [passes, default 2]
# The forks are made in batches by fresh processes: on macOS one process that forks a hundred thousand
# times gets slower and slower (a first version of this script took 40 minutes for one pass).
import os
import signal
import subprocess
import sys
import time

BATCH = 4000

if len(sys.argv) > 2 and sys.argv[1] == "--batch":
    targets = {int(x) for x in sys.argv[2].split(",")}
    hits, first, last, wrapped = [], None, 0, 0
    for _ in range(BATCH):
        pid = os.fork()
        if pid == 0:
            os._exit(0)
        os.waitpid(pid, 0)
        if pid in targets:
            hits.append(pid)
        if first is None:
            first = pid
        if pid < last:
            wrapped += 1
        last = pid
    print(first, last, wrapped, ",".join(map(str, hits)))
    sys.exit(0)

passes = int(sys.argv[1]) if len(sys.argv) > 1 else 2

# The leader: a new session and group, one member that sleeps, then the leader exits.
r, w = os.pipe()
leader = os.fork()
if leader == 0:
    os.setsid()
    member = os.fork()
    if member == 0:
        os.close(w)
        time.sleep(7200)
        os._exit(0)
    os.write(w, str(member).encode())
    os._exit(0)
os.close(w)
member = int(os.read(r, 32))
os.waitpid(leader, 0)
pgid = os.getpgid(member)
print(f"leader {leader} exited; member {member} lives with pgid {pgid} (the dead leader's pid: {pgid == leader})")
try:
    os.kill(leader, 0)
    print("the leader's pid still answers to kill(pid, 0)")
except ProcessLookupError:
    print("kill(leader, 0): no such process (as a pid the number is free)")

# Controls: the numbers just below the leader's were pids of processes that are gone, so they are free.
controls = [pgid - 40, pgid - 30, pgid - 20]
targets = [pgid, member] + controls
given = {t: 0 for t in targets}
passed = 0
forks = 0
started = time.time()
while passed < passes:
    out = subprocess.run(
        [sys.executable, __file__, "--batch", ",".join(map(str, targets))], capture_output=True, text=True
    ).stdout.split()
    first, last, wrapped = int(out[0]), int(out[1]), int(out[2])
    for hit in out[3].split(",") if len(out) > 3 else []:
        given[int(hit)] += 1
    forks += BATCH
    # The counter went past the group's number inside this batch (with or without a wrap in it).
    if (wrapped == 0 and first <= pgid <= last) or (wrapped > 0 and (pgid >= first or pgid <= last)):
        passed += 1
        print(f"pass {passed}: the counter went from {first} to {last} after {forks} forks, {time.time() - started:.0f} s", flush=True)
print(f"times given out as a pid: the group's number {pgid}: {given[pgid]}; the live member {member}: {given[member]}; "
      f"free numbers near it {controls}: {[given[c] for c in controls]}")
print(f"the group's number was given to a new process: {'YES' if given[pgid] else 'no'}")
os.kill(member, signal.SIGKILL)
