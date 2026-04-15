# Information Risk Management (IRM) Report

**Organization:** EVOLV Fishing / ESI Lookup Services  
**Author:** Claude Code (claude-sonnet-4-6)  
**Date:** 2026-04-15  
**Scope:** All applications, infrastructure, and data assets on the production AWS EC2 environment  

---

## 1. Asset Inventory

### 1.1 Information Assets

| Asset | Classification | Location | Description |
|-------|---------------|----------|-------------|
| ESI IDs + Service Addresses | Sensitive / PII | esi-lookup (in-memory) | Texas electricity service identifiers with customer premises addresses |
| Dealer Application Data | Business Sensitive | my-react-app (client-side) | EVOLV Fishing wholesale dealer applications |
| Order Logging Database | Business Confidential | AWS RDS PostgreSQL (`OrderLogging`) | Business transaction and order records |
| SmartMeterTexas.com Credentials | Secret | Environment variable (`SMT_USERNAME`, `SMT_PASSWORD`) | Third-party API credentials for Texas utility data |
| ERCOT MIS Certificate | Secret | Environment variable (`ERCOT_CERT`, `ERCOT_KEY`) | Market participant certificate for ERCOT grid operator |
| ESI Lookup Password | Secret | Environment variable (`LOOKUP_PASSWORD`) | Application authentication password |
| GitHub Personal Access Token | Secret | Git remote URLs (plaintext) | Token authorizing push access to GitHub repositories |
| RDS Database Password | Secret | Terraform variable | PostgreSQL master password |
| SSH Private Keys | Secret | User workstation(s) | SSH access to production server |

### 1.2 Application Assets

| Application | URL | Technology | Purpose |
|-------------|-----|------------|---------|
| esi-lookup | esilookup.com | Node.js / Express | ESI ID lookup tool integrating SmartMeterTexas.com and ERCOT |
| excellook | w.evolvfishing.com | React / Vite (static) | Spreadsheet web application |
| my-react-app | w.evolvfishing.com | React / Vite (static) | EVOLV Fishing wholesale dealer portal |

### 1.3 Infrastructure Assets

| Asset | Details |
|-------|---------|
| EC2 Instance | c1.medium, Ubuntu 24.04, us-east-1b |
| RDS PostgreSQL | db.t3.micro, v16, storage-encrypted, single-AZ |
| Elastic IP | Static public IP attached to EC2 |
| AWS Security Group (web) | SSH/HTTP/HTTPS open to 0.0.0.0/0 |
| AWS Security Group (RDS) | PostgreSQL from EC2 security group only |
| CDN / WAF | Cloudflare (esilookup.com) |
| Process Manager | PM2 v6 |
| Web Server | Nginx 1.24.0 |

---

## 2. Threat Landscape

The following threats have been identified as relevant to this environment:

| Threat | Source | Likelihood |
|--------|--------|-----------|
| Automated bot scanning | Internet | **Confirmed** (observed in logs) |
| Brute-force SSH attack | Internet | High |
| Credential stuffing on web apps | Internet | Medium |
| Third-party data breach (GitHub, AWS) | External | Medium |
| Data loss on server restart | Operational | High |
| Ransomware / server compromise | Internet | Medium |
| Insider threat | Internal | Low |
| Physical breach of AWS data centre | Physical | Very Low |

---

## 3. Risk Register

Risks are rated by **Likelihood (1–5)** × **Impact (1–5)** = **Risk Score (1–25)**.

| Rating | Score |
|--------|-------|
| Critical | 20–25 |
| High | 12–19 |
| Medium | 6–11 |
| Low | 1–5 |

---

### RISK-01 — GitHub Personal Access Token Stored in Plaintext

**Rating: Critical (20)**  
**Likelihood: 4 | Impact: 5**

The GitHub PAT is embedded directly in the git remote URLs for `esi-lookup` and `excellook`. It is readable by anyone with shell access to the server or who can read `.git/config`:

```
https://<username>:<TOKEN>@github.com/mzarzour/esi-lookup.git
```

A compromised server immediately yields a token that can be used to read, modify, or delete all GitHub repositories associated with the account — including pushing malicious code to production.

**Treatment: Mitigate**
- Remove PAT from all remote URLs: `git remote set-url origin https://github.com/mzarzour/esi-lookup.git`
- Rotate the PAT immediately (the exposed one should be considered compromised)
- Use SSH deploy keys (per-repo) or a GitHub Actions machine token instead
- Store any required tokens in AWS Secrets Manager or environment variables, not in file paths

---

### RISK-02 — SSH Open to the Internet (0.0.0.0/0)

**Rating: Critical (20)**  
**Likelihood: 4 | Impact: 5**

The AWS security group allows SSH (port 22) from any IP address (`0.0.0.0/0`). Combined with no fail2ban, no host-based firewall (UFW is inactive), and default SSH configuration (no explicit `MaxAuthTries` or `AllowUsers` restrictions), this is the primary attack surface for full server compromise. Automated brute-force SSH attacks were observed in system logs.

**Treatment: Mitigate**
- Restrict SSH to specific trusted IPs in the security group (e.g. your home/office IP)
- Or deploy an AWS Systems Manager Session Manager policy and disable direct SSH entirely (SSM Agent is already installed)
- Enable fail2ban: `apt install fail2ban`
- Set `MaxAuthTries 3` and `AllowUsers ubuntu` in `/etc/ssh/sshd_config`
- Activate UFW: `ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp && ufw enable`

---

### RISK-03 — ESI / Customer Address Data Held in Unprotected In-Memory Store

**Rating: High (16)**  
**Likelihood: 4 | Impact: 4**

The esi-lookup application stores up to 200,000 ESI ID and service address records (customer PII) in a plain Node.js `Map` object. This data:
- Is **lost permanently** every time the server restarts or the PM2 process crashes
- Has **no encryption at rest**
- Has **no access logging** (queries are not recorded)
- Is accessible to anyone who can crash or restart the process

ESI IDs with service addresses constitute PII under Texas utility regulations. Loss or unauthorized access could create regulatory and legal exposure.

**Treatment: Mitigate**
- Persist the lookup database to the provisioned RDS PostgreSQL instance (`OrderLogging` database) instead of in-memory
- Encrypt data in transit to RDS (already enforced by security group; ensure SSL connection string is used)
- Implement query-level audit logging
- Define a data retention and deletion policy

---

### RISK-04 — RDS Instance Has No Automated Backups

**Rating: High (12)**  
**Likelihood: 3 | Impact: 4**

The Terraform configuration for the RDS PostgreSQL instance does not set `backup_retention_period`, which defaults to **0 (no automated backups)**. The `skip_final_snapshot = false` only takes a single snapshot at deletion time — it does not protect against accidental data deletion, corruption, or ransomware during operation.

**Treatment: Mitigate**
- Set `backup_retention_period = 7` (7-day rolling backups) in `terraform/main.tf`
- Enable point-in-time recovery
- Consider setting `multi_az = true` for production availability

---

### RISK-05 — `LOOKUP_PASSWORD` Not Set in Production

**Rating: High (12)**  
**Likelihood: 3 | Impact: 4**

The esi-lookup server generates a **random password on each startup** when the `LOOKUP_PASSWORD` environment variable is not set:

```
WARNING: LOOKUP_PASSWORD not set — using generated password for this session
```

This means every PM2 restart (e.g. after a crash, deploy, or server reboot) invalidates all user sessions and the password changes without notice. If the warning log is not monitored, operators may not know the new password. This also suggests credentials are not being managed systematically.

**Treatment: Mitigate**
- Set `LOOKUP_PASSWORD` as a persistent environment variable via PM2 ecosystem config or AWS Secrets Manager
- Do not store the password in any plaintext file on disk — inject it at runtime

---

### RISK-06 — No Host-Based Firewall (UFW Inactive)

**Rating: Medium (9)**  
**Likelihood: 3 | Impact: 3**

UFW is installed but inactive. The server relies entirely on the AWS security group for network-level protection. If the security group is misconfigured (e.g. a future Terraform change), all ports on the instance become publicly accessible with no secondary control.

**Treatment: Mitigate**
- Enable UFW as a defence-in-depth measure:
  ```bash
  ufw default deny incoming
  ufw allow 22/tcp
  ufw allow 80/tcp
  ufw allow 443/tcp
  ufw enable
  ```

---

### RISK-07 — No Brute-Force Protection on SSH (fail2ban Absent)

**Rating: Medium (9)**  
**Likelihood: 4 | Impact: 3** *(partially mitigated by key-based auth)*

fail2ban is not installed. Automated SSH scanners are already probing the server (observed in error logs). While SSH key-based authentication reduces the risk of successful brute-force, the noise increases log volume and consumes server resources.

**Treatment: Mitigate**
- `apt install fail2ban` — default config will auto-ban IPs after 5 failed SSH attempts
- Primary fix remains RISK-02 (restrict SSH CIDR)

---

### RISK-08 — RDS Single-AZ Deployment (No Failover)

**Rating: Medium (8)**  
**Likelihood: 2 | Impact: 4**

The RDS instance has `multi_az = false`. An availability zone outage, hardware failure, or maintenance window will cause the database — and by extension any application depending on it — to become unavailable with no automatic failover.

**Treatment: Accept / Mitigate**
- For the current scale, single-AZ may be an acceptable cost trade-off
- When `OrderLogging` becomes business-critical, set `multi_az = true` in Terraform

---

### RISK-09 — RDS Username Hardcoded in Terraform

**Rating: Medium (6)**  
**Likelihood: 2 | Impact: 3**

The RDS master username `markzarzour` is hardcoded in `terraform/main.tf`. This is a personal name used as a database superuser identity, which creates issues for access review, credential rotation, and the principle of least privilege.

**Treatment: Mitigate**
- Use a non-personal, role-based username (e.g. `evolv_admin`)
- Parameterise it as a variable in `variables.tf`

---

### RISK-10 — Self-Signed SSL Certificate (w.evolvfishing.com)

**Rating: Low (4)**  
**Likelihood: 2 | Impact: 2**

The HTTPS certificate for `w.evolvfishing.com` is self-signed and will display browser security warnings to all users, damaging trust and potentially causing users to bypass certificate warnings habitually.

**Treatment: Mitigate**
- Run `certbot --nginx -d w.evolvfishing.com` once Cloudflare access restrictions allow the HTTP-01 challenge to reach the server

---

### RISK-11 — esilookup.com Missing Security Headers

**Rating: Low (4)**  
**Likelihood: 2 | Impact: 2**

`esilookup.com` is missing `X-Content-Type-Options`, `Referrer-Policy`, and `Content-Security-Policy` headers (already fixed on `w.evolvfishing.com` during pen test). It also still discloses the nginx version.

**Treatment: Mitigate**
- Apply the same header block and `server_tokens off` to the esilookup nginx config

---

### RISK-12 — No Centralised Monitoring or Alerting

**Rating: Medium (8)**  
**Likelihood: 2 | Impact: 4**

There is no CloudWatch alerting, uptime monitoring, or log aggregation. Incidents (crashes, spikes, breaches) are only discoverable by manually reviewing logs after the fact. The PM2 `esi-lookup` process has already restarted 5 times (visible in PM2 status), with no alert generated.

**Treatment: Mitigate**
- Enable CloudWatch agent for CPU, memory, and disk metrics
- Configure a CloudWatch alarm for the PM2 process crashing (or use PM2's built-in `pm2 monit`)
- Set up uptime monitoring (e.g. UptimeRobot, free tier) for esilookup.com

---

## 4. Risk Summary Matrix

| Risk ID | Title | Rating | Treatment | Status |
|---------|-------|--------|-----------|--------|
| RISK-01 | GitHub PAT in git remote URLs | **Critical** | Mitigate | Open |
| RISK-02 | SSH open to internet | **Critical** | Mitigate | Open |
| RISK-03 | Customer PII in unprotected memory | **High** | Mitigate | Open |
| RISK-04 | No RDS automated backups | **High** | Mitigate | Open |
| RISK-05 | LOOKUP_PASSWORD unset in production | **High** | Mitigate | Open |
| RISK-06 | No host-based firewall | **Medium** | Mitigate | Open |
| RISK-07 | No SSH brute-force protection | **Medium** | Mitigate | Open |
| RISK-08 | RDS single-AZ | **Medium** | Accept/Mitigate | Open |
| RISK-09 | RDS username hardcoded | **Medium** | Mitigate | Open |
| RISK-10 | Self-signed SSL (w.evolvfishing.com) | **Low** | Mitigate | Open |
| RISK-11 | esilookup.com missing security headers | **Low** | Mitigate | Open |
| RISK-12 | No monitoring or alerting | **Medium** | Mitigate | Open |

---

## 5. Existing Controls (What Is Working)

| Control | Coverage |
|---------|----------|
| RDS storage encryption at rest | Database data encrypted |
| RDS not publicly accessible | Database not internet-reachable |
| RDS security group locks down PostgreSQL to EC2 only | Network-level DB isolation |
| HTTPS enforced with HTTP→HTTPS redirect | w.evolvfishing.com |
| HSTS, X-Frame-Options, CSP, X-Content-Type-Options, Referrer-Policy | w.evolvfishing.com |
| HSTS, X-Frame-Options on esilookup.com | Partial header coverage |
| TLS 1.0 / 1.1 disabled | Both domains |
| Formula injection blocked (new Function guard) | excellook |
| SSH key-based authentication | Server access |
| In-app brute-force protection (5 attempts → 15 min lockout) | esi-lookup login |
| In-app rate limiting (20 req/min for lookups, 100/min general) | esi-lookup API |
| Token-based session auth with 8-hour TTL | esi-lookup |
| CORS restricted (disabled unless CORS_ORIGIN env var is set) | esi-lookup API |
| Directory listing disabled | Nginx |
| HTTP methods restricted (DELETE/PUT/TRACE return 405) | Nginx |
| Nginx version hidden | w.evolvfishing.com |
| Unattended security upgrades enabled | OS patching |
| npm audit: 0 vulnerabilities | All 3 projects |
| Cloudflare WAF / DDoS protection | esilookup.com |

---

## 6. Recommended Remediation Priority

### Immediate (This Week)

1. **Rotate the GitHub PAT** — the current token is exposed; generate a new one and update remotes to use SSH keys or the new token securely
2. **Restrict SSH CIDR** — change `0.0.0.0/0` to your office/home IP in the AWS security group
3. **Set `LOOKUP_PASSWORD`** — persist via PM2 ecosystem file or AWS Secrets Manager
4. **Enable UFW** — five commands; zero downtime

### Short-Term (This Month)

5. **Migrate esi-lookup in-memory store to RDS** — protect customer PII
6. **Enable RDS automated backups** — add `backup_retention_period = 7` to Terraform
7. **Install fail2ban** — `apt install fail2ban`
8. **Fix Let's Encrypt for w.evolvfishing.com**
9. **Apply security headers to esilookup.com nginx config**

### Medium-Term (Next Quarter)

10. **Set up CloudWatch monitoring and alerting**
11. **Refactor RDS username** to a non-personal role account
12. **Evaluate RDS multi-AZ** when `OrderLogging` becomes operationally critical
13. **Define a data retention policy** for ESI / address data

---

## 7. Data Protection Notes

The esi-lookup application processes **ESI IDs and residential/commercial service addresses**, which constitute personally identifiable information under Texas utility and privacy regulations. Relevant considerations:

- **Purpose limitation:** Data should only be used for ESI address resolution, not shared or used for other purposes
- **Retention:** Define how long imported ESI data is retained and implement automated purging
- **Access:** Currently only password-protected; consider IP allowlisting for production use
- **Audit trail:** No query logging exists — consider logging ESI lookups (without full address in the log) for compliance

---

*Report generated on 2026-04-15 by Claude Code*
