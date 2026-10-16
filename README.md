# Rosier Support Intelligence

Internal platform for Rosier Foods. It brings customer support conversations from **MyOperator (calls)**, **LimeChat (chat/WhatsApp)**, the **WhatsApp Business Platform** and **email (Gmail / Microsoft 365)** into one place. From there it:

- transcribes calls with **Sarvam AI**
- analyses every conversation with **Claude**: summary, issue classification, quality score, evidence-linked alerts
- turns the alerts reviewers confirm into coaching plans for agents

It ships with a fully working **demo mode**: 164 synthetic interactions, clearly labelled **DEMO DATA**, so you can use every screen before connecting real accounts.

---

## 1. Run it on your Mac (about 5 minutes)

**Requirements:** Node.js 20 or newer (`node -v`). Docker is not needed.

Open Terminal in this folder and run:

```bash
npm install          # install dependencies
npm run init         # creates .env.local with a fresh encryption key
```

**Terminal 1: start a local Postgres database.** Leave it running.

```bash
npm run db:local
```

**Terminal 2: create the tables, load demo data, start the app.**

```bash
npm run setup        # migrations + organisation defaults + DEMO DATA
npm run dev          # http://localhost:3000
```

**Terminal 3 (optional): run the background worker.** It handles transcription, AI analysis, syncs, SLA checks and retention.

```bash
npm run worker
```

Open http://localhost:3000 and sign in with a demo account. The password for all of them is `RosierDemo@2026`.

| Account | Role |
|---|---|
| admin@rosier.demo | Super Admin (everything) |
| crm@rosier.demo | CRM Manager |
| lead.calls@rosier.demo | Team Leader (Inbound Calls team only) |
| qa@rosier.demo | Quality Analyst |
| priya@rosier.demo | Support Agent (sees only her own work) |

**Create your own real admin account:**

```bash
npm run user:create -- --email you@rosierfoods.com --name "Your Name" --role super_admin
```

This prints a one-time temporary password. After signing in, open **Profile & security** to change it and turn on two-factor authentication.

---

## 2. Use Supabase instead of the local database

1. Create a Supabase project.
2. Go to **Project Settings → Database → Connection string → URI**. Use the **session pooler** or the direct connection.
3. In `.env.local`, set:
   ```
   DATABASE_URL=postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres
   DATABASE_SSL=no-verify
   ```
4. Run `npm run setup`.

What the migrations do on Supabase:

- **Row-level security:** every table has RLS enabled and forced. The app runs each request as the `rsi_app` role with the caller's organisation set, so one organisation can never read another's rows.
- **No public API access:** the Supabase `anon` and `authenticated` roles have their access revoked, so these tables are **not** reachable through Supabase's auto-generated REST API.

For private storage of recording copies, set the following:

```
STORAGE_DRIVER=supabase
SUPABASE_URL=https://<ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service role key>
SUPABASE_STORAGE_BUCKET=rsi-private
```

Create the bucket as **private** in the Supabase dashboard. The service role key stays on the server only.

> **Auth note:** sign-in uses the app's own secure session authentication: bcrypt passwords, httpOnly cookies, optional TOTP two-factor and account lockout. Supabase is used for Postgres and Storage. This keeps it portable: the same code runs on Supabase or any Postgres 15+.

---

## 3. Connecting real data

Sign in as a Super Admin and open **Integrations & API Settings**. Each provider card shows:

- what permissions are needed and what will be imported
- the fields to fill in
- a private webhook URL to register with the provider
- **Test connection** — a card only turns *Connected* after a successful test
- **Sync now**, historical import, sync runs and webhook event logs

Credentials are encrypted (AES-256-GCM) and only ever shown masked.

| Provider | What you need |
|---|---|
| **LimeChat** | Account ID and API access token. Register the webhook URL in LimeChat. |
| **MyOperator** | API token and/or the after-call webhook. Confirm the call-log endpoint path with MyOperator support (it's configurable). |
| **WhatsApp Cloud API** | App secret and verify token. Optionally a system-user token. Webhooks capture messages from setup onward; Meta has no history API. |
| **Gmail / Microsoft 365** | An OAuth app (client ID/secret) from Google Cloud or Azure. Then click *Connect*. |
| **Sarvam AI** | API subscription key. Used for Hindi/English/Hinglish call transcription. |
| **Claude** | Anthropic API key. Model is configurable (default `claude-sonnet-5-5`). |

`docs/INTEGRATIONS.md` has per-provider setup steps, scopes, webhook verification, rate limits and known limitations, with links to the provider docs each adapter was built from.

**Before going live:**

1. Replace the template policies in **Knowledge Base** with Rosier's approved SOPs and publish them. Until then, AI analysis of real conversations flags *policy uncertainty* instead of relying on template text.
2. Map agents to their MyOperator/LimeChat user IDs in **Team Management → Agents**.
3. Remove demo data in **System Settings → Demo data**, and set `DEMO_SHOW_CREDENTIALS=false`.
4. Set the retention periods in **System Settings**, and the SLAs/business hours in **AI Configuration**.

---

## 4. What's in the app

| Area | Highlights |
|---|---|
| **Overview Dashboard** | 16 KPIs computed from stored records (hover ⓘ for the formula). Volume, issues, leaderboard, alerts, sentiment, product complaints, peak hours, bottlenecks. Every chart drills down. |
| **Unified Inbox / Calls / Chat & WhatsApp / Email** | Filters, full-text search, sort, pagination, CSV export (permission-checked and audited). Detail view shows the timestamped transcript or full thread. Alerts jump to and highlight the exact evidence. Reviewers can correct AI scores and labels. |
| **AI Quality Monitoring** | Alert review queue: start review, confirm, false positive, assign, escalate, resolve, assign coaching. Every decision is recorded. AI flags are treated as *potential concerns*; nothing is automatic. |
| **Customer Issues & Root Causes** | Pareto analysis, trends, breakdowns by product/channel/agent/source. Confirmed vs suspected (AI-inferred) root causes. Period comparisons only when the sample is big enough. |
| **Agent Performance** | Quality, FCR, response/resolution times, compliance, case mix. Sample-size guards. Side-by-side comparison. |
| **Coaching & Improvement** | AI-drafted coaching from confirmed alerts, using only approved knowledge-base text. Agent acknowledgement workflow, then measured improvement against baseline. |
| **Reports & Analytics** | 10 reports with CSV download and print/PDF layout. |
| **Integrations, AI Configuration, Knowledge Base, Team, Audit Logs, Settings** | Rubric weights per channel, score bands, alert rules, taxonomy, SLAs, versioned SOPs, users/roles/permissions, sessions, retention, demo reset. |

---

## 5. Commands

| Command | Does |
|---|---|
| `npm run init` | Create `.env.local` with a new encryption key |
| `npm run db:local` | Local Postgres 17 in `./.pgdata` (no Docker) |
| `npm run setup` | `db:migrate` + `db:seed` |
| `npm run db:seed -- --no-demo` | Organisation defaults only (production) |
| `npm run db:reset-demo` | Regenerate demo data |
| `npm run user:create -- --email … --role …` | Create or reset a user |
| `npm run dev` / `build` / `start` | Next.js |
| `npm run worker` | Background job worker |
| `npm test` · `npm run typecheck` · `npm run lint` | Quality checks |

## 6. Documentation

- `docs/ARCHITECTURE.md`: components, data flow, processing pipeline, database
- `docs/INTEGRATIONS.md`: provider-by-provider setup and limitations
- `docs/METRICS.md`: every KPI formula
- `docs/SECURITY.md`: auth, RBAC, encryption, RLS, audit, privacy, retention
- `docs/DEPLOYMENT.md`: production hosting, worker, cron, backups, go-live checklist
- `docs/CONVENTIONS.md`: for developers extending the code
