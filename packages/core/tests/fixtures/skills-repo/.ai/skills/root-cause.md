---
name: deep-root-cause
description: Extra root-cause guidance for this repo's domain.
cezar-stages: [root-cause, verify-in-repo]
---

# Repo root-cause notes

When tracing a bug here, start from `src/server/handlers/` — most defects bubble
up from a mis-wired handler. Check the request-id middleware before blaming the
database layer.
