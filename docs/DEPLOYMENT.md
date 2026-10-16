# Deployment

You need two always-on processes sharing one database:
1. **Web app:** `npm run build && npm start`, behind HTTPS.
2. **Worker:** `npm run worker`. It is long-running and processes transcription, analysis, syncs, SLA checks and retention.

Without the worker, webhooks and syncs are still recorded and queued, but nothing gets processed.

## Recommended setup
- **Database:** Supabase (Postgres 15+). Use the session pooler or a direct connection with `DATABASE_SSL=no-verify` (or `require` with a trusted CA).
- **Web + worker:** any Node 20+ host that can run a persistent process, e.g. Render, Railway or Fly.io (web service + background worker), or a VM with `pm2`/systemd. Serverless-only hosting (e.g. Vercel alone) needs a separate worker host.
- **Storage:** Supabase Storage, private bucket (`STORAGE_DRIVER=supabase`).
- **Scheduler (optional):** the worker already schedules syncs every minute. If you also want an external heartbeat, call `POST /api/cron/tick` with `Authorization: Bearer $CRON_SECRET`.

## Steps
1. Provision the database, then set the environment variables from `.env.example` on **both** processes. They must share the same `SECRETS_ENCRYPTION_KEY`.
2. `npm ci && npm run db:migrate && npm run db:seed -- --no-demo`
3. `npm run user:create -- --email admin@rosierfoods.com --name "Admin" --role super_admin`
4. `npm run build`, start the web app, start the worker.
5. Set `APP_URL` to the public HTTPS URL. Webhook URLs and OAuth redirect URIs are built from it. Register the OAuth redirect URIs shown on the Gmail/M365 cards in Google Cloud / Azure.
6. Sign in, enable MFA, connect integrations, publish approved knowledge-base policies, map agents to provider user IDs.

## Operations
- **Backups:** enable Supabase point-in-time recovery or daily backups. Back up `SECRETS_ENCRYPTION_KEY` separately; without it, stored credentials can't be decrypted.
- **Monitoring:** Integrations shows each connection's health, last sync, last error, sync runs and webhook events. AI Configuration shows the job queue with failed/dead jobs and retry. The worker logs to stdout without message contents or secrets.
- **Scaling:** run more worker replicas. Jobs are claimed with `SKIP LOCKED`, so replicas never double-process. Tune `WORKER_CONCURRENCY` to stay within provider rate limits.
- **Upgrades:** `npm run db:migrate` is idempotent (`schema_migrations`). Never edit an applied migration; add a new one.
- **Reprocessing:** after changing the model, rubric or policies, use AI Configuration → Reprocess to re-analyse a date range. Human corrections are preserved.

## Go-live checklist
- [ ] HTTPS, and `APP_URL` set to the public URL
- [ ] `DEMO_SHOW_CREDENTIALS=false` and demo data removed (System Settings)
- [ ] Every admin has MFA enabled
- [ ] Knowledge base: template policies replaced and published
- [ ] Agents mapped to MyOperator/LimeChat IDs
- [ ] Retention periods, SLAs and business hours reviewed
- [ ] Call-recording consent notice confirmed with legal
- [ ] Backups and encryption-key backup confirmed
