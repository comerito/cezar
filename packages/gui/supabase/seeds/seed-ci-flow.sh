#!/usr/bin/env bash
# Seed a CI-flow row for local testing of ci-watch / ci-attribute / ci-fix.
#
# Usage:
#   DATABASE_URL=postgres://... \
#   WS_SLUG=my-workspace \
#   USER_EMAIL=you@example.com \
#   REPO_OWNER=myorg REPO_NAME=myrepo \
#   PR_NUMBER=42 PR_HEAD_SHA=abc123... \
#   PR_BRANCH=autofix/cezar-issue-9999 \
#   ISSUE_NUMBER=9999 \
#     ./packages/gui/supabase/seeds/seed-ci-flow.sh

set -euo pipefail

: "${DATABASE_URL:?set DATABASE_URL to your local Supabase postgres connection string}"
: "${WS_SLUG:?}"
: "${USER_EMAIL:?}"
: "${REPO_OWNER:?}"
: "${REPO_NAME:?}"
: "${PR_NUMBER:?}"
: "${PR_HEAD_SHA:?}"
: "${PR_BRANCH:?}"
: "${ISSUE_NUMBER:?}"

HERE="$(cd "$(dirname "$0")" && pwd)"

psql "$DATABASE_URL" \
  --set ON_ERROR_STOP=on \
  --set ws_slug="$WS_SLUG" \
  --set user_email="$USER_EMAIL" \
  --set repo_owner="$REPO_OWNER" \
  --set repo_name="$REPO_NAME" \
  --set pr_number="$PR_NUMBER" \
  --set pr_head_sha="$PR_HEAD_SHA" \
  --set pr_branch="$PR_BRANCH" \
  --set issue_number="$ISSUE_NUMBER" \
  -f "$HERE/seed-ci-flow.sql"
