# Contributing to Canva Invite Manager

Thank you for taking the time to contribute. This document covers everything you need to go from idea to merged pull request — including local setup, code conventions, the review process, and how to report issues responsibly.

All contributions are governed by the [Code of Conduct](#code-of-conduct) at the bottom of this file. By participating you agree to uphold it.

---

## Table of Contents

- [Ways to Contribute](#ways-to-contribute)
- [Before You Start](#before-you-start)
- [Local Development Setup](#local-development-setup)
- [Project Architecture Primer](#project-architecture-primer)
- [Making Changes](#making-changes)
  - [Branching Convention](#branching-convention)
  - [Commit Message Standard](#commit-message-standard)
  - [Code Style](#code-style)
  - [Security-Sensitive Changes](#security-sensitive-changes)
- [Testing Your Changes](#testing-your-changes)
- [Submitting a Pull Request](#submitting-a-pull-request)
  - [PR Checklist](#pr-checklist)
  - [Review Process](#review-process)
- [Reporting Bugs](#reporting-bugs)
- [Requesting Features](#requesting-features)
- [Reporting Security Vulnerabilities](#reporting-security-vulnerabilities)
- [Code of Conduct](#code-of-conduct)

---

## Ways to Contribute

You do not need to write code to contribute meaningfully.

| Type | How |
|---|---|
| 🐛 **Bug report** | [Open a bug report](https://github.com/williethecool/canva-inviter/issues/new?template=bug_report.md) |
| 💡 **Feature request** | [Open a feature request](https://github.com/williethecool/canva-inviter/issues/new?template=feature_request.md) |
| 🔒 **Security vulnerability** | See [Reporting Security Vulnerabilities](#reporting-security-vulnerabilities) — do **not** open a public issue |
| 📖 **Documentation** | Fix typos, improve clarity, add missing examples |
| 🌍 **Deployment guides** | Document platform-specific steps or real-world gotchas you encountered |
| 💬 **Discussion** | Answer questions in [GitHub Discussions](https://github.com/williethecool/canva-inviter/discussions) |
| 🔀 **Code** | Implement features from the [roadmap](README.md#roadmap) or fix open bugs |

---

## Before You Start

For anything beyond a straightforward typo fix or documentation tweak, please **open or comment on an issue first**. This saves everyone time by ensuring:

- The change aligns with the project's direction and constraints
- Nobody else is already working on the same thing
- There is agreement on the approach before implementation begins

For features on the [roadmap](README.md#roadmap), comment on the relevant issue to express interest — a maintainer will assign it to you.

---

## Local Development Setup

**Requirements:** Node.js ≥ 18, a Cloudflare account (free tier is fine)

### 1. Fork and clone

```bash
git clone https://github.com/your-username/canva-inviter.git
cd canva-inviter
```

### 2. Install Wrangler

```bash
npm install -g wrangler
wrangler login
```

### 3. Create a local KV namespace for development

```bash
wrangler kv:namespace create INVITE_KV --preview
```

Copy the preview namespace ID output into a local `wrangler.toml` (do not commit this file):

```toml
name = "canva-inviter"
main = "worker.js"
compatibility_date = "2024-01-01"

kv_namespaces = [
  { binding = "INVITE_KV", id = "your-preview-namespace-id", preview_id = "your-preview-namespace-id" }
]
```

### 4. Set local environment variables

Create a `.dev.vars` file in the project root. **Never commit this file** — it is already listed in `.gitignore`.

```bash
CANVA_INVITE_URL=https://www.canva.com/brand/join?token=REPLACE_ME
ADMIN_USERNAME=admin
ADMIN_PASSWORD=localdevpassword
SESSION_SECRET=0000000000000000000000000000000000000000000000000000000000000000
```

> For a real `SESSION_SECRET`, run this in your browser console:
> ```javascript
> Array.from(crypto.getRandomValues(new Uint8Array(32)))
>   .map(b => b.toString(16).padStart(2, '0')).join('')
> ```

### 5. Start the local dev server

```bash
wrangler dev --local
```

The Worker is now running at `http://localhost:8787`. The admin panel is at `http://localhost:8787/admin/login`.

---

## Project Architecture Primer

Before making changes, it helps to understand the key invariants the codebase upholds:

| Invariant | Why it matters |
|---|---|
| **Single file, zero dependencies** | `worker.js` is deployed by pasting into the Cloudflare dashboard. Adding a build step breaks that. |
| **Canva URL never reaches the client** | The URL is used only in a `302 Location` header, never written to HTML, JS, or logs. |
| **All user input goes through `sanitize()` and `e()`** | `sanitize()` caps length and strips dangerous characters; `e()` HTML-escapes values before interpolation. |
| **Every admin POST validates CSRF** | Call `validateCSRF(request, session)` at the top of any new admin mutation handler. |
| **Codes are never logged in full** | Use `obfuscate(code)` (renders as `AB****34`) whenever writing a code to a log entry. |
| **Timing-safe paths on auth and redemption** | Use `timingSafeEqual()` for credential comparison and keep the 150 ms `sleep()` on redemption failures. |

Violating any of these invariants will block a PR from merging regardless of other quality.

---

## Making Changes

### Branching Convention

Create your branch from `main` using one of these prefixes:

| Prefix | Purpose | Example |
|---|---|---|
| `feat/` | New features | `feat/webhook-on-redemption` |
| `fix/` | Bug fixes | `fix/issue-42-session-expiry` |
| `docs/` | Documentation only | `docs/wrangler-toml-guide` |
| `refactor/` | Code restructuring, no behaviour change | `refactor/extract-html-helpers` |
| `security/` | Security improvements | `security/bcrypt-admin-password` |
| `chore/` | Tooling, CI, repo maintenance | `chore/add-issue-templates` |

```bash
git checkout -b feat/my-feature-name
```

---

### Commit Message Standard

This project follows the [Conventional Commits](https://www.conventionalcommits.org/) specification. Every commit message must be structured as:

```
<type>(<scope>): <short imperative description>

[optional body — explain the why, not the what]

[optional footer]
Fixes #123
```

**Valid types:** `feat` · `fix` · `docs` · `refactor` · `security` · `test` · `chore`

**Common scopes:** `auth` · `bulk` · `codes` · `logs` · `ratelimit` · `export` · `ui` · `kv` · `deploy`

**Examples:**

```
feat(bulk): add server-side TXT and CSV export endpoint

Adds GET /admin/codes/export?format=txt|csv with optional ?batch=id
parameter. When batch ID is present, exports only that batch. Without
it, streams all codes from KV in chunked reads.

Fixes #18
```

```
fix(auth): prevent session fixation on logout

Delete the KV session entry before clearing the cookie so an
intercepted cookie cannot be reused after the user logs out.
```

```
security(ratelimit): scope redeem counter to IP + code prefix

Adds a secondary per-code-prefix rate limit to prevent distributed
enumeration attacks that spread attempts across many IPs.
```

**Keep the subject line under 72 characters and in the imperative mood** ("add", "fix", "remove" — not "added", "fixes", "removed").

---

### Code Style

There is no linter or formatter enforced at the CI level — the style rules are intentionally minimal and described here in plain English.

**Structure**
- Keep all code in a single `worker.js` — do not split into modules or introduce a build step
- Use `export default { async fetch() {} }` as the entry point
- Group related functions together with section header comments (`// ─────── SECTION NAME`)

**Naming**
- Handler functions: `handleVerbNoun` — e.g. `handleBulkCreate`, `handleToggleCode`
- Page functions: `nounPageHTML` — e.g. `codesPageHTML`, `logsPageHTML`
- Predicates: `isVerb` or `hasNoun` — e.g. `isExpired`, `isValidEmail`
- Avoid abbreviations except for established ones (`env`, `url`, `ip`, `rl`, `kv`)

**HTML generation**
- Generate HTML in template literals co-located with the handler or page function that uses it
- Always escape interpolated user values with the `e()` helper — no exceptions
- Never build HTML by string-concatenating raw user input

**Comments**
- Comment the *why*, not the *what*: `// constant-time delay prevents timing-based code enumeration` not `// sleep 150ms`
- Security-relevant blocks must have a one-line rationale comment
- Keep inline comments short; use a paragraph above the function for longer explanations

**Async / error handling**
- Prefer `await` over `.then()` chains
- Wrap top-level handler logic in try/catch and return a graceful error page
- Non-fatal operations (e.g. log writes) should be fire-and-forget with a `catch(() => {})` — never let a logging failure break a redemption

---

### Security-Sensitive Changes

Any change touching the following areas requires extra care and a brief threat model comment in the PR description:

- Session creation, validation, or expiry
- CSRF token generation or validation
- Admin credential comparison
- Rate limiting logic
- Code validation or redemption path
- KV read/write operations that affect code state
- Any new endpoint that mutates data

For these changes, explicitly answer in the PR body:
1. What could go wrong if this change has a bug?
2. What makes you confident the change is safe?

---

## Testing Your Changes

There is no automated test suite at this time (see [roadmap](README.md#roadmap)). Test your changes manually against these scenarios:

### Redemption flow

| Scenario | Expected result |
|---|---|
| Valid code + valid email | 302 redirect to `CANVA_INVITE_URL` |
| Valid code + invalid email | Error page, code **not** decremented |
| Non-existent code | Generic error, no information leakage |
| Expired code | Generic error (same message as above) |
| Exhausted code (max_uses reached) | Generic error (same message as above) |
| Disabled code | Generic error (same message as above) |
| 6 attempts from same IP in 15 min | 5th succeeds (if valid), 6th is rate-limited |
| Canva URL in page source / network | Must **not** appear anywhere client-visible |

### Admin panel

| Scenario | Expected result |
|---|---|
| Correct credentials | Session cookie set, redirect to dashboard |
| Wrong credentials | 401, login failure logged |
| 11 login attempts in 15 min | 11th is rate-limited |
| Create code with past expiry | Validation error, no code written |
| Bulk generate 10 codes | Batch panel appears with all 10 codes |
| Bulk generate 201 codes | Browser confirmation dialog shown |
| Copy All button | All codes appear in clipboard, one per line |
| Export CSV | Download with `code,max_uses,expiration_date` header |
| Toggle disable/enable | Status badge updates, code is rejected/accepted |
| Delete code | Code removed, no longer redeemable |
| CSRF token removed from form | POST rejected with 403 |
| Expired session cookie | Redirect to `/admin/login` |

---

## Submitting a Pull Request

### PR Checklist

Before marking your PR as ready for review, confirm every item below:

**Architecture**
- [ ] `worker.js` remains a single self-contained file with no `import` statements from external URLs
- [ ] No `npm` packages or third-party dependencies have been introduced

**Security**
- [ ] All user-supplied values are passed through `sanitize()` before use
- [ ] All HTML-interpolated values are escaped with `e()`
- [ ] Any new admin POST handler calls `validateCSRF(request, session)` as its first action
- [ ] Codes are never written to logs in full — `obfuscate(code)` is used
- [ ] Timing-safe comparison (`timingSafeEqual`) is used wherever credentials or tokens are compared
- [ ] The Canva invite URL does not appear in any HTML, JS, or log output

**Quality**
- [ ] Commit messages follow [Conventional Commits](#commit-message-standard)
- [ ] New or changed behaviour is described clearly in the PR body
- [ ] Manual testing has been performed against the relevant scenarios in [Testing Your Changes](#testing-your-changes)
- [ ] If the change is security-sensitive, a threat model comment is included in the PR description

---

### Review Process

1. A maintainer will review your PR within a few days. Please be patient — this is a spare-time project.
2. Reviews may request changes. Address each point with a commit and a brief reply comment explaining what you changed.
3. Once approved, a maintainer will squash-merge the PR into `main` with a clean commit message.
4. Merged contributions are credited in the release notes.

If a PR has no activity for 30 days after a review request, it will be marked stale and may be closed. You are welcome to reopen it.

---

## Reporting Bugs

Use the **[bug report template](https://github.com/williethecool/canva-inviter/issues/new?template=bug_report.md)**.

Before filing:
- Search [open issues](https://github.com/williethecool/canva-inviter/issues) to see if it has already been reported
- Check that you are running the latest version of `worker.js`
- If the bug is security-related, see [Reporting Security Vulnerabilities](#reporting-security-vulnerabilities) instead

A good bug report includes:
- Exact steps to reproduce (not "it doesn't work")
- What you expected to happen
- What actually happened (error message, HTTP status, screenshot)
- Your deployment environment (region, any custom domain, relevant env var configuration without values)

---

## Requesting Features

Use the **[feature request template](https://github.com/williethecool/canva-inviter/issues/new?template=feature_request.md)**.

Before filing:
- Check the [roadmap](README.md#roadmap) — your idea may already be planned
- Search [open issues](https://github.com/williethecool/canva-inviter/issues) to avoid duplicates
- Consider whether the feature can be implemented within the project's core constraint: **a single-file, zero-dependency Cloudflare Worker**

The most useful feature requests explain the *problem* you are trying to solve, not just the solution you have in mind. A well-described problem often leads to a better solution than the one originally proposed.

---

## Reporting Security Vulnerabilities

**Do not open a public GitHub issue for security vulnerabilities.**

Please report security issues by emailing the maintainer directly or using [GitHub's private vulnerability reporting](https://github.com/williethecool/canva-inviter/security/advisories/new) feature.

Include:
- A description of the vulnerability and its potential impact
- Steps to reproduce or a proof-of-concept (responsible disclosure only)
- Any suggested mitigations you have in mind

You will receive an acknowledgement within 72 hours. We aim to release a fix within 14 days for critical issues. We will credit you in the release notes unless you prefer to remain anonymous.

---

## Code of Conduct

This project adopts the [Contributor Covenant](https://www.contributor-covenant.org/version/2/1/code_of_conduct/) Code of Conduct.

In short: be respectful, be constructive, and assume good faith. Harassment, discrimination, and personal attacks of any kind will result in removal from the project.

Violations can be reported to the maintainer privately via the contact method listed in the security policy. All reports will be handled confidentially.

---

*Thank you for helping make Canva Invite Manager better. Every contribution — no matter how small — is genuinely appreciated.*
