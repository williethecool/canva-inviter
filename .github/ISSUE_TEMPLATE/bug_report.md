---
name: "🐛 Bug Report"
about: "Something is broken or behaving unexpectedly"
title: "[BUG] "
labels: ["bug", "needs-triage"]
assignees: []
---

<!--
  Thank you for taking the time to file a bug report.

  Before submitting:
  ✅ Search open issues to check this hasn't been reported already:
     https://github.com/williethecool/canva-inviter/issues

  ✅ Make sure you are using the latest version of worker.js.

  🔒 If this is a security vulnerability, do NOT file a public issue.
     Use GitHub's private reporting instead:
     https://github.com/williethecool/canva-inviter/security/advisories/new
-->

## Bug Description

<!-- A clear, concise description of what is broken. -->



## Steps to Reproduce

<!-- Provide the exact steps needed to trigger the bug. "It doesn't work" is not enough — we need to be able to reproduce it ourselves. -->

1. Go to `...`
2. Enter `...`
3. Click `...`
4. Observe `...`

## Expected Behaviour

<!-- What did you expect to happen? -->



## Actual Behaviour

<!-- What actually happened? Include the exact error message, HTTP status code, or screenshot if applicable. -->



## Environment

| Field | Value |
|---|---|
| **Worker.js version / commit** | <!-- e.g. commit SHA or date you copied the file --> |
| **Cloudflare region** | <!-- e.g. US, EU, or "unsure" --> |
| **Custom domain?** | <!-- Yes / No --> |
| **Browser (if UI bug)** | <!-- e.g. Chrome 124, Safari 17 --> |
| **Affected surface** | <!-- Public redemption page / Admin panel / Both --> |

## Relevant Configuration

<!--
  Describe any relevant configuration WITHOUT including actual secret values.
  ✅ Good: "CANVA_INVITE_URL is set"
  ❌ Bad: "CANVA_INVITE_URL=https://canva.com/brand/join?token=abc123"
-->

- `CANVA_INVITE_URL` configured: <!-- Yes / No -->
- `SESSION_SECRET` configured: <!-- Yes / No -->
- KV namespace bound as `INVITE_KV`: <!-- Yes / No -->
- Any non-default constants modified in `worker.js`: <!-- List them or "None" -->

## Logs / Error Output

<!--
  Paste any relevant output from:
  - The browser console (F12 → Console)
  - The Cloudflare Workers dashboard logs (Workers → your worker → Logs)
  - The admin panel log viewer (/admin/logs)

  Redact any personal data (email addresses, IP addresses) before pasting.
-->

```
Paste logs here
```

## Additional Context

<!--
  Anything else that might help diagnose the issue:
  - Does it happen consistently or intermittently?
  - Did it ever work? If so, when did it stop?
  - Are there any recent changes to your deployment?
  - Screenshots or screen recordings are welcome.
-->



## Possible Fix

<!--
  Optional — if you have a hunch about what might be causing the bug or have
  already looked at the code, share your thoughts h
  ere. Even partial ideas help.
-->
