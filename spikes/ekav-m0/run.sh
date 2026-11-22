#!/bin/sh
# TASK-EKAV step 1 driver. Needs a PTY, the network and a signed-in `claude` (`claude auth login`), so it
# runs in a person's terminal, not in the Claude sandbox. Throwaway: it makes folders under $P and writes
# transcripts under ~/.claude/projects; it never accepts a trust dialog and never touches ~/.claude.json.
#   sh run.sh            the short checks (about 10 minutes, a few cents on haiku)
#   sh run.sh hour       criterion 5 with an hour of idleness
#   sh run.sh compact    criterion 8 with three compactions typed by hand (a stand-in for a long conversation)
set -u
cd "$(dirname "$0")"
# A folder claude already trusts (here `/private/tmp` is trusted in ~/.claude.json); the repository's own
# root also is, so `P=<root>/.kodel/worktrees` works where /private/tmp does not.
P="${EKAV_PARENT:-/private/tmp}"
W="${EKAV_WORKTREE:-$(cd ../.. && pwd)}"
case "${1:-short}" in
hour) node wake.mjs "$P" 3600; exit ;;
compact) D=$(mktemp -d "$P/ekav-resume.XXXXXX"); node resume.mjs "$D" --compact 3; exit ;;
esac
echo "--- 1, 2, 3, 6, 7 (idle): a start in the run's worktree"
node start.mjs c1-worktree "$W" --idle 120
echo "--- 3: a one-word prompt that names a subcommand, as it is and with a newline after it"
D=$(mktemp -d "$P/ekav-start.XXXXXX")
node start.mjs c3-doctor "$D" --prompt doctor --idle 1
node start.mjs c3-doctor-nl "$D" --prompt "doctor
" --idle 1
echo "--- 4 and 11: the deny list, then kodel's own guard"
node gate.mjs "$P" model
node gate.mjs "$P" model --no-deny
node gate.mjs "$P" shell
echo "--- 5: kodel wait wakes the idle session (30 s)"
node wake.mjs "$P" 30
echo "--- 8 and 9: resume"
D=$(mktemp -d "$P/ekav-resume.XXXXXX"); node resume.mjs "$D"
echo "--- 10: the holder's child, its group, the holder killed; then the pid of a group"
bun group.ts "$P"
bun group.ts "$P" --stand-in
python3 pidreuse.py
