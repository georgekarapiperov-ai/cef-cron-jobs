#!/usr/bin/env bash
# Publishes <dir> as a single fresh commit on <branch> (force-push, so the branch never grows).
set -euo pipefail
DIR="$1"; BRANCH="$2"
cd "$DIR"
printf '{\n  "git": { "deploymentEnabled": false }\n}\n' > vercel.json   # never let Vercel build data branches
rm -rf .git
git init -q
git checkout -q -b "$BRANCH"
git add -A
git -c user.name="cef-data-bot" -c user.email="41898282+github-actions[bot]@users.noreply.github.com" commit -q -m "data: $BRANCH $(date -u +%Y-%m-%dT%H:%MZ)"
# 5 tries with growing pauses (15 s, 30 s, 1 min, 2 min): a short GitHub hiccup (like the 2026-10-07 "Internal Server
# Error" during GitHub's Git-operations incident) no longer fails the run.
for wait in 15 30 60 120 0; do
  if git push -q -f "https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY}.git" "$BRANCH"; then echo "published $BRANCH"; exit 0; fi
  if [ "$wait" -gt 0 ]; then echo "push failed — trying again in ${wait}s"; sleep "$wait"; fi
done
echo "push failed after 5 tries"; exit 1
