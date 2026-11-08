# DictatorVPN

[![CI](https://github.com/hdjsjsdhdhhs-prog/VPNbuilderDictator/actions/workflows/docker.yml/badge.svg?branch=main)](https://github.com/hdjsjsdhdhhs-prog/VPNbuilderDictator/actions/workflows/docker.yml)
[![Go](https://img.shields.io/badge/Go-1.25-00ADD8?logo=go)](https://go.dev/)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL%203.0-blue.svg)](LICENSE)

DictatorVPN is a Telegram VPN subscription service that has **no VPN servers of its
own and no access to any VPN panel**. It aggregates ready subscription URLs of VPN
providers and lets the administrator compose personal subscriptions from them:

```text
provider subscription URLs → Sources → proxy catalogue → Builders and rules
  → one personal subscription URL (/sub/{token}) → the user's VPN client
```

1. The administrator adds ready provider subscription URLs as **Sources** (optional
   authorization headers, HWID, User-Agent; base64, plain links, Xray/3x-ui JSON or
   Clash/Mihomo YAML).
2. Each Source is fetched and parsed on the server into a **catalogue** of proxies
   (country, protocol, stable fingerprint); re-syncs track added and disappeared servers.
3. A **Builder** combines several Sources with ordered rules: all servers, whole
   countries or specific servers, renames, enable/disable, profile metadata, preview.
4. A Builder is assigned to a tariff (plan default) or to one subscription (override).
5. `/sub/{token}` assembles the content on request from the live provider responses,
   deduplicates, caches and serves one subscription for the user's VPN client. Expiry
   and revocation apply immediately; if no Source can be fetched the endpoint answers
   503 instead of serving stale or foreign content.

This project started from [kereal/rs8kvn_bot](https://github.com/kereal/rs8kvn_bot)
(AGPL-3.0, see [NOTICE.md](NOTICE.md)). The VPN-panel architecture of that project
(3x-ui/proxman nodes, client registration, panel sync and traffic workers) has been
removed; see [doc/architecture.md](doc/architecture.md).

## Features

- 🤖 **Telegram bot** — subscription on demand with QR import, invites and referrals,
  expiry reminders, admin commands and resumable broadcasts
- 🛠️ **Admin Panel** (`/admin-ui/`) — overview, users and subscription lifecycle,
  tariffs and the trial editor, customer warm-up, Sources and catalogues, Builders,
  network monitoring of the served servers, event journal
- 📱 **Telegram Mini App** (`/miniapp/`) — subscription status, connection page with
  VPN app picker and deep links, tariff purchase (Platega, Telegram Stars)
- 🌐 **Sources → Builders → `/sub`** — multi-source aggregation without VPN panels
- 🎁 **Trial** — anonymous short-lived access served only by the trial plan Builder
- 💳 **Payments** — Platega (webhook with constant-time auth) and Telegram Stars
- 📈 Prometheus `/metrics`, Sentry, daily SQLite backups, embedded migrations
- 🔒 Security hardening — admin session + CSRF + Origin checks, credential-free admin
  and client responses, private-address filtering of provider references

## Quick Start

```bash
docker pull ghcr.io/hdjsjsdhdhhs-prog/vpnbuilderdictator:latest

docker run -d \
  --name rs8kvn_bot \
  --restart unless-stopped \
  -v $(pwd)/.env:/app/.env:ro \
  -v $(pwd)/data:/app/data \
  -p 127.0.0.1:8880:8880 \
  ghcr.io/hdjsjsdhdhhs-prog/vpnbuilderdictator:latest
```

> The registry provides `latest`, SemVer (`X.Y.Z`, `X.Y`) and commit SHA tags. Pin a
> concrete SemVer or SHA tag when reproducible deployments are required. The runtime
> names (`rs8kvn_bot` binary/container, `rs8kvn-bot.service`, `rs8kvn.db`) are kept
> for compatibility with existing installations.

See **[Installation Guide](doc/installation.md)** for all installation methods, the
full configuration table, Source/Builder setup, migrations and backups.

## Usage

1. Start the bot with `/start`
2. Use the inline buttons:
   - **For users with subscription:**
     - **🚀 Подписка** — subscription status, expiry and link
       - **📱 QR-код** — QR code for VPN app import
       - **🏠 В начало** — return to the main menu
     - **💎 Купить Premium** — buy or renew a paid plan (shown when `PAYMENT_ENABLED=true`)
     - **☕ Донат** — donation info
     - **📖 Помощь** — help and support contact (`CONTACT_USERNAME`)
     - **📑 Документы** — documents / legal menu
   - **For users without subscription:**
     - **📥 Получить подписку** — create a new subscription
3. Admin users also see **📊 Стат** — bot statistics

## User Commands

| Command | Description |
|---------|-------------|
| `/start` | Start working with the bot / main menu |
| `/mysub` | Show your subscription info (status, expiry, subscription link) |
| `/help` | Show bot help |
| `/invite` | Get your referral link |

## Admin Commands

| Command | Description |
|---------|-------------|
| `/lastreg` | Show the last 10 registered users |
| `/del <id>` | Delete a subscription by database ID |
| `/setplan <subscription_id> <plan_id> [days]` | Change a subscription's plan through the service layer (extends expiry; defaults to 30 days when none given) |
| `/broadcast` | Start an asynchronous broadcast: name → message → filters → preview → confirm |
| `/broadcasts` | Show recent broadcasts; open details, cancel active campaigns, or retry failed recipients |
| `/send <id or @username> <message>` | Send a message to a specific user |
| `/refstats` | Show referral statistics (count per user from cache) |

**Broadcast flow:** `/broadcast` collects a name, message, filters, and confirmation.
The campaign sends immediately or can be scheduled in Moscow time. Its audience and
per-recipient state are persisted, so delivery is resumable after restarts without
duplicates. Use `/broadcasts` to view details, cancel active campaigns, or retry
failed recipients.

## Web Endpoints

The bot exposes HTTP endpoints on `WEB_SERVER_PORT` (default 8880):

| Endpoint | Description | Status Codes |
|----------|-------------|--------------|
| `GET /healthz` | Basic health (process alive, DB status) | 200/503 |
| `GET /readyz` | Ready state (accepting requests after init) | 200/503 |
| `GET /sub/{token}` | Subscription assembled by the resolved Builder | 200/404/405/503 |
| `GET /subscription-info/{token}` | Public subscription status (JSON) | 200/404 |
| `GET /connect/{token}` | Connection page: VPN app picker, deep links, QR | 200/404 |
| `GET /i/{code}` | Trial invite landing page | 200/404/429/500 |
| `/admin-ui/`, `/admin/*` | Admin Panel and its session/API (`ADMIN_*` settings) | — |
| `/miniapp/`, `/api/miniapp/*` | Telegram Mini App and its API (Telegram initData auth) | — |
| `POST /payment/callback` | Platega payment webhook (X-MerchantId / X-Secret) | 200/400/401/405/503 |
| `GET /metrics` | Prometheus metrics | 200 |
| `GET /static/logo.png` | Logo image | 200/404 |

### Subscription Server (`/sub/{token}`)

Serves subscriptions assembled by the resolved Subscription Builder (per-subscription
override, otherwise the plan default) from its ProviderSource catalogues. The cache key
includes the Builder version and the state of its Sources, so configuration changes
and catalogue syncs are visible on the next request. A failure of one Source is
skipped; if no linked Source can be fetched the endpoint answers 503 — there is no
fallback pipeline. Optional access logging via `SUBSERVER_ACCESS_LOG`.

## Expiry

Access is local state: a subscription row (status, plan, expiry). There is no
panel-side traffic accounting.

- A paid subscription has `expires_at`; the expiry worker downgrades an expired paid
  subscription to the free plan. The free plan has no expiry.
- Trials are anonymous, short-lived subscriptions (duration from the admin trial
  settings, `TRIAL_DURATION_HOURS` is the default). Expired trials are claimed and
  deleted by the trial cleanup worker.
- Expiry reminders (3d / 1d / 3h) are sent to active paid subscriptions.

## Releases

1. Tag `main` with a SemVer tag and push it (e.g. `git tag -a vX.Y.Z -m "Release vX.Y.Z" && git push origin vX.Y.Z`).
2. The CI/CD pipeline runs Go tests (with `-race`), `go vet`, golangci-lint, gosec,
   frontend typecheck/lint/unit tests and builds.
3. A verified linux/amd64 binary (`-trimpath`, `CGO_ENABLED=1`, `vcs.modified=false`,
   SHA-256) and the Docker image `ghcr.io/hdjsjsdhdhhs-prog/vpnbuilderdictator` are built.
4. A GitHub Release is created with the binary and its checksum.

## Development

```bash
# Go
go test -count=1 ./...
go test -race -count=1 ./...
go vet ./... && go vet -tags adminsmoke ./internal/web/
golangci-lint run ./...
gosec ./...

# Frontend (Admin Panel + Mini App)
cd frontend
npm ci
npm run typecheck && npm run lint && npm test
npm run build && npm run build:admin
npx playwright test && npx playwright test -c playwright.admin.config.ts
```

### Project Documentation

- **[Installation & Configuration](doc/installation.md)** — setup methods, env vars, Source/Builder setup
- **[Architecture](doc/architecture.md)** — system architecture, data model, subscription content assembly
- **[Handover](doc/handover.md)** — stack, current state, nuances
- **[Security Policy](doc/security.md)** — security measures, hardening checklist
- **[API Reference](doc/api.md)** — HTTP endpoints, error codes, rate limits
- **[Operations Guide](doc/operations.md)** — deployment, monitoring, troubleshooting, backup/restore
- **[Broadcast](doc/broadcast.md)**, **[Customer warm-up](doc/customer-warmup.md)**,
  **[Event journal](doc/journal.md)**, **[Mini App UI](doc/miniapp-ui.md)**,
  **[VPN apps](doc/vpn-apps.md)**, **[Telegram Stars](doc/telegram-stars.md)**,
  **[Subscription management](doc/subscription-management.md)**
- **[Database migrations](internal/database/migrations/README.md)** — why the historical migrations are kept
