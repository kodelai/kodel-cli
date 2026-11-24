#!/bin/sh
# Criteria 4, 5 and 11 need a throwaway project that claude trusts, and trust is the person's act.
# 1) `sh trust.sh` opens claude in the fixed folder: choose "Yes, I trust this folder", then type /exit.
# 2) `sh trust.sh run` runs the checks there (the scripts empty and reuse the folder; trust is kept by path).
#    `sh trust.sh hour` runs criterion 5 with an hour of idleness.
set -eu
cd "$(dirname "$0")"
TOP=/private/tmp/ekav-trusted
case "${1:-trust}" in
trust)
  # Build the same project the checks use (git, .kodel), so the dialog is the one they meet.
  EKAV_TOP="$TOP" node -e 'import("./lib.mjs").then((m) => m.project("/private/tmp"))'
  cd "$TOP/project"
  exec claude
  ;;
run)
  export EKAV_TOP="$TOP"
  echo "--- 4 and 11"
  node gate.mjs /private/tmp model
  node gate.mjs /private/tmp model --no-deny
  node gate.mjs /private/tmp shell
  echo "--- 5 (30 s)"
  node wake.mjs /private/tmp 30
  ;;
hour)
  EKAV_TOP="$TOP" node wake.mjs /private/tmp 3600
  ;;
esac
