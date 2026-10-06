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
for i in 1 2 3; do
  if git push -q -f "https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY}.git" "$BRANCH"; then echo "published $BRANCH"; exit 0; fi
  sleep 10
done
echo "push failed after 3 tries"; exit 1
