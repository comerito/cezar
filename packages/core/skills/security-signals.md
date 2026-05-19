---
name: security-signals
description: Signals for spotting security-relevant issues even when not explicitly labelled.
cezar-stages:
  - security
---

# Security signals

Goal: flag issues with security implications, even when they aren't labelled
"security". False positives are acceptable here — it's better to flag and
review than to miss a vulnerability.

## Detection categories

- **Authentication bypass** — login or session issues that could allow
  unauthorized access.
- **Session hijacking** — session fixation, cookie theft, token leakage in
  URLs / logs / referrers.
- **Privilege escalation** — users gaining access beyond their assigned
  role; horizontal or vertical.
- **Injection** — SQL, command, path traversal, XSS, template injection,
  prompt injection on AI features.
- **Data exposure** — API keys in logs, PII leakage, sensitive data in
  error responses or 4xx bodies, secrets in URLs.
- **Credential logging** — passwords, tokens, or session cookies written
  to logs / consoles / metrics.
- **Dependency vulnerabilities** — known CVEs in libraries, outdated
  packages with public security fixes.

## Confidence and severity

- Confidence reflects how clearly the issue describes a security problem
  (0.0–1.0). Flag only when confidence ≥ **0.70**.
- Severity reflects the **potential impact if exploited**, not how clearly
  the issue is written:
    - `critical` — RCE, auth bypass, mass PII leak.
    - `high` — privilege escalation, credential exposure, exploitable
      injection.
    - `medium` — limited data exposure, denial-of-service.
    - `low` — informational, defence-in-depth.

## Read the full body

Security details are often subtle and buried mid-body. Don't rely on the
title alone. Check comments for CVE references or severity clarifications.

## When it's not a security issue

Set `isSecurityRelated: false` and leave category / severity / explanation
empty — don't moralise about unrelated security best-practice.
