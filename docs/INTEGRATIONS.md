# Integrations

Admins connect each provider on **Integrations & API Settings** (`/integrations`, permission `integrations.manage`).
This document is the reference for what each connector needs, what it imports, and how it behaves.

## How every connector works

| Topic | Behaviour |
|---|---|
| Credential storage | Secrets are encrypted with AES-256-GCM (`SECRETS_ENCRYPTION_KEY`) in `integration_connections.secrets_enc`. They are never sent to the browser (masked as `••••••••1234`), logged, or included in errors. A blank secret field on save keeps the stored value; "Remove saved value" clears it explicitly. |
| Status | `Not connected` → **Save** → `Configured – not tested` → **Test connection** passes → `Connected`. A failed test → `Error`. A connection is only marked connected after a successful test, or (for webhook-only setups) after the first webhook that passes signature/shared-key verification. Changing credentials returns the status to `Configured` and pauses scheduled sync until it's re-tested. |
| Disconnect | Deletes the stored credentials, turns sync off, cancels queued jobs and revokes the webhook URL (a new URL is generated on the next save). Imported data is kept. |
| Audit | Save, test, OAuth, sync requests, sync toggles, disconnect and job retries are written to `audit_logs`, with field *names* only and never values. |
| Webhook URL | `{APP_URL}/api/webhooks/{provider}/{token}`. `token` is a random 24-byte value per connection. Unknown tokens, or tokens used with a different provider, get a 404. |
| Webhook intake | Body limit 1 MB (413 above that). Rate limit 600 requests/min per token (429). The signature or shared key is verified *before* anything is processed. Every POST is stored in `webhook_events` with sanitised headers (authorisation, cookies and signatures are redacted). Duplicates (`UNIQUE(connection_id, event_key)`) are acknowledged with 200 and ignored. A `webhook_process` job is queued and the endpoint returns 200 straight away. A failed verification returns 401 and is stored with `signature_valid = false`. |
| Scheduled sync | The worker calls `enqueueDueSyncs()`, and so does `POST /api/cron/tick`. A connection that is `Connected` with sync turned on gets a `sync` job once every *frequency* minutes. Each page of results is ingested and its checkpoint saved in **one transaction**, so a crash never skips records and a retry never duplicates them. A run fetches at most 20 pages (40 for a historical import); if more remain, a continuation job is queued. |
| Historical import | Pick a start date and click **Run historical import**. This runs as a separate background job with its own checkpoint, so it doesn't disturb incremental sync. |
| Idempotency | An interaction is unique on `(org_id, source_platform, source_record_id)`. Chat messages are unique on `(thread_id, external_message_id)` and emails on `(interaction_id, external_message_id)`. Re-delivered records update in place, and new messages are added to the existing thread. |
| Rate limits / retries | HTTP 429 and 5xx responses become retryable errors that honour `Retry-After`. The job queue backs off exponentially (30 s × 2^attempt, up to 6 h, 5 attempts) and then marks the job as failed. Failed jobs appear on the card with a **Retry** button (needs `processing.retry`). 401/403/404 errors are not retried. They mark the connection `Error` with a readable message. |
| Token expiry | For OAuth providers, the access token is refreshed with the stored refresh token 90 s before it expires. The new token (and a rotated refresh token, if Microsoft sends one) is saved encrypted, and `token_expires_at` is updated. |
| Customer data | Customers are matched by `sha256(normalised phone)` or `sha256(lowercased email)`. Raw phone/email are stored unless the org setting `privacy.storeCustomerContact` is `false`. Call numbers are only ever stored masked. Raw provider payloads are kept only in `webhook_events`, never on interactions. |
| Agents | Matched by `agents.external_ids->>{provider}`, then by email. Unknown agents are created automatically (no team yet). Assign them in Team Management. |

### Cron endpoint

`POST /api/cron/tick` with header `Authorization: Bearer $CRON_SECRET` queues due syncs and recovers jobs left stale by a dead worker. It returns 401 if `CRON_SECRET` isn't set or doesn't match. Use it from any external scheduler, for example:

```bash
curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" https://rsi.example.com/api/cron/tick
```

The background worker (`npm run worker`) processes webhook events, syncs, transcription and analysis. Without it, events are stored but not processed.

---

## LimeChat

**What's needed:** API base URL (default `https://app.limechat.ai`), **Account ID** (the number after `/accounts/` in the dashboard URL), **API access token** (Profile settings → Access token). Optionally an **Inbox ID** filter.

**Permissions:** an agent or administrator token that can see the inboxes you want analysed. The connector reads conversations and messages only.

**Imported:** complete conversation threads in order with timestamps; sender type (customer / agent / bot / system); assigned agent (id, name, email); conversation status (open → `open`, pending/snoozed → `pending`, resolved → `resolved`); contact name/phone/email; attachment metadata. Private agent notes are **not** imported. A conversation is marked WhatsApp when its channel is `Channel::Whatsapp`, otherwise chat.

**API used (Chatwoot-compatible):** LimeChat's own integration docs show its account API at `https://app.limechat.ai/api/v1/accounts/{account_id}/…` with the `api_access_token` header, which is the Chatwoot Application API pattern.
- `GET /api/v1/accounts/{account_id}/conversations?status=all&assignee_type=all&page=N[&inbox_id=]` (used by Test connection and sync)
- `GET /api/v1/accounts/{account_id}/conversations/{id}/messages[?before={message_id}]` (pages backwards in steps of 20 until the start, up to 1,000 messages)

**Sync method:** the conversation list has no "updated since" filter. Sync pages through it newest-activity first and stops at the first conversation older than the checkpoint (`last_activity_at`, with a 2-minute overlap). Each conversation it changes gets its full thread re-fetched. There is a 150 ms pause between conversations and 500 ms between pages.

**Webhook:** register the card's webhook URL under Settings → Integrations → Webhooks and subscribe to `message_created`, `message_updated`, `conversation_created`, `conversation_status_changed` (optionally `conversation_updated`).
- **Verification:** if LimeChat shows a webhook secret, save it as *Webhook signing secret*. Requests are then verified with `X-Chatwoot-Signature = "sha256=" + HMAC-SHA256(secret, "{X-Chatwoot-Timestamp}.{raw body}")`, and anything older than 5 minutes is rejected. If no secret is offered, set a *Webhook shared key* and register the URL with `?key=<shared key>`. Requests without a valid signature or key are rejected.
- **Dedupe key:** `X-Chatwoot-Delivery` if present, otherwise `{event}:{id}:{updated_at|created_at}`.

**Limitations / assumptions:** the endpoint paths come from Chatwoot's API reference, because LimeChat doesn't publish a separate one. If your LimeChat plan uses a different host, change the base URL. If Test connection reports an unexpected format, ask LimeChat support which API is enabled for your account. Attachments are referenced (`data_url`), not copied.

**Docs:** https://moengage.com/docs/partner-guide/support-and-service/conversational-messaging/limechat · https://developers.chatwoot.com/api-reference/conversations/conversations-list · https://developers.chatwoot.com/api-reference/messages/get-messages · https://www.chatwoot.com/hc/user-guide/articles/1677693021-how-to-use-webhooks

---

## WhatsApp Business Platform (Cloud API)

**What's needed:** **App secret** (Meta App Dashboard → App settings → Basic) and a **verify token** you choose. Optionally a **Phone number ID** (filters to one number) and a **system-user access token**, used only by Test connection to read the number's display name.

**Permissions:** subscribe the app to the `messages` webhook field of your WhatsApp Business Account. The optional token needs `whatsapp_business_management` / `whatsapp_business_messaging`.

**Imported:** inbound customer messages (text, button/list replies, captions, location/contacts placeholders) with timestamps, the customer's WhatsApp number and profile name, and media metadata (type, file name, media id; files are not downloaded). Messages from one customer on one IST calendar day form one interaction, because WhatsApp has no conversation id for inbound messages.

**Webhook:** in WhatsApp → Configuration → Webhook, paste the card's URL and the verify token, then click *Verify and save*.
- `GET` handshake: `hub.mode=subscribe` with a matching `hub.verify_token` echoes `hub.challenge`, and the card shows *Verified*.
- `POST`: `X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(app secret, raw body)`, compared in constant time.
- **Dedupe key:** `wamid:{message id}`. Meta retries failed deliveries for up to 36 hours.

**Sync method:** none. **The Cloud API has no message-history endpoint**, so only messages received after the webhook is set up are imported, and historical import isn't available.

**Limitations:** messages your business sends through the API come back only as delivery `statuses` (no text), so agent replies are not captured by this connector. Connect LimeChat if agents reply through it. Status-only webhooks are stored as `ignored`.

**Docs:** https://developers.facebook.com/docs/graph-api/webhooks/getting-started · https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/overview · https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages.md

---

## MyOperator

**What's needed:**
- **For webhooks (recommended):** a *Webhook shared key* (any long random string), plus the name of the custom header you'll configure in MyOperator (default `X-Webhook-Token`).
- **For scheduled sync / historical import:** the *Public API token* (panel → Manage → API integration). APIs are not available on Lite plans.
- **Optional:** a *Webhook signing secret*, if HMAC signing is enabled for your webhook.

**Permissions:** call logs (read) and recording links. Recording is only available if it's enabled on your plan.

**Imported:** call id, direction, customer number (stored hashed for matching and shown masked), handling agent (MyOperator user id / name / email), start/end time, duration, ring time where available, status (answered / missed / voicemail / failed), and the recording URL. Answered calls with a recording URL are queued for transcription. Missed calls are marked completed with no analysis.

**Webhook:** in MyOperator → Webhooks (after-call / call logs), add the card's URL with method POST and the custom header `X-Webhook-Token: <shared key>`. Map "Recording URL" if your panel offers field mapping. Accepted authentication, checked in this order: HMAC `X-Webhook-Signature` (if a signing secret is saved); the configured custom header; `?key=` query parameter; the Basic-auth password. MyOperator documents several payload generations, and all are accepted:
1. The legacy short-key call log, sent as JSON or as the form field `myoperator=<json>`: `_pm[ui]` / `_ai` id, `_cl`/`_cr` caller, `_st`/`_et`, `_dr`, `_ty` (1 in / 2 out), `_su` (1 connected / 2 missed / 3 voicemail), `_fu` recording URL, `_fn` file name, `_ld[]._rr` agent.
2. `call.completed`: `event_id`, `call_id`, `direction`, `from`, `to`, `status`, `started_at`/`ended_at`, `duration_seconds`, `recording_url`, `agent`.
3. Webhook v2 `call.end` / `call.summary`: `session_id`, `customer_identifier`, `data.status`, `data.duration`, `data.recording_filename`, `data.legs[].agent`. In-progress events (`call.initiated`, `call.answered`) are ignored.

- **Dedupe key:** `event:{event_id}` when present, otherwise `call:{id}:{status}:{rec|norec}`. A later delivery that adds a recording updates the call and triggers transcription.

**Sync method:** `GET {base}{logs path}?token=…&from=<unix>&to=<unix>&page_size=100&log_from=<offset>`. The base defaults to `https://developers.myoperator.co` and the path to `/search`. Results are read from `data.hits[]._source`, `data[]` or `logs[]`. The checkpoint is the newest call start time, with a 5-minute overlap.

**Rate limits:** documented as 20 requests/min, 100/hour and 500/day per account. Sync waits 3.5 s between pages and honours `Retry-After` on 429.

**Limitations / assumptions:**
- MyOperator's public docs give the base URL, the token-in-query authentication and the search parameters, but not a verifiable path for the call-log endpoint. The path is therefore a configurable field (default `/search`), so confirm it for your account. Webhooks are the primary, documented path.
- Recording links expire after **24 hours**, so transcription should run promptly.
- If only a recording *file name* arrives, the call is stored with `recording_available = false`, because a file name can't be fetched.
- Date strings without a timezone are treated as IST.

**Docs:** https://myoperator.com/api/ · https://support.myoperator.com/portal/en/kb/articles/what-are-apis-23-8-2025 · https://support.myoperator.com/portal/en/kb/articles/after-call-webhook · https://support.myoperator.com/portal/en/kb/articles/in-call-webhook · https://support.myoperator.com/portal/en/kb/articles/what-is-an-after-call-webhook-and-how-do-i-configure-it · https://support.myoperator.com/portal/en/kb/articles/what-is-the-exact-payload-structure-for-every-myoperator-webhook-v2-event

---

## Gmail / Google Workspace

**What's needed:** a Google Cloud project with the Gmail API enabled, an OAuth consent screen (Internal for Workspace), and an OAuth client of type *Web application* whose authorised redirect URI is `{APP_URL}/api/oauth/gmail/callback` (shown on the card). Enter the client ID and secret, save, then click **Connect with Google** while signed in as the support mailbox.

**Scopes:** `https://www.googleapis.com/auth/gmail.readonly`, `openid`, `email`. The connector cannot send, modify or delete mail. It requests `access_type=offline` and `prompt=consent` so it receives a refresh token, which is stored encrypted.

**OAuth flow:**
1. `GET /api/oauth/gmail/start` (needs `integrations.manage`) stores a single-use state (only its SHA-256 is kept) that expires after 10 minutes, then redirects to `accounts.google.com/o/oauth2/v2/auth`.
2. The callback checks the state and that the same signed-in admin is returning, exchanges the code at `oauth2.googleapis.com/token`, and stores the tokens encrypted.
3. It then runs Test connection (`users.getProfile`). The connection becomes Connected only if that test passes.

**Imported:** threads matching the *Mailbox filter* (default `in:inbox -category:promotions -category:social`): subject, From/To/Cc, timestamps, and the plain-text body with quoted history removed (HTML is converted to text). Attachment metadata only. Messages from the *Support team addresses* (plus the connected mailbox) or carrying the `SENT` label count as agent replies.

**Sync method:** `users.threads.list?q=<filter> after:<unix>` (25 per page) followed by `users.threads.get?format=full` for each thread. Messages that arrive later in a thread are added to the same interaction. After a completed run, the checkpoint moves to the run's start time minus 1 hour.

**Rate limits:** per-user quota units. 429 / `rateLimitExceeded` responses are retried with backoff.

**Limitations:** polling only (push notifications need Cloud Pub/Sub). Replies from a shared mailbox are attributed to that mailbox, not to an individual agent.

**Docs:** https://developers.google.com/identity/protocols/oauth2/web-server · https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.threads/list · https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.threads/get · https://developers.google.com/workspace/gmail/api/guides/filtering · https://developers.google.com/workspace/gmail/api/reference/quota

---

## Microsoft 365 / Outlook

**What's needed:**
1. In Entra admin center, create an app registration with a *Web* redirect URI of `{APP_URL}/api/oauth/m365/callback`.
2. Add delegated Microsoft Graph permissions **Mail.Read**, **User.Read** and **offline_access**, and grant admin consent if your tenant requires it.
3. Create a client secret.
4. Enter the Application (client) ID, the secret value and the tenant (tenant id, or `organizations`), save, then click **Connect with Microsoft**.

**Scopes:** `offline_access openid email User.Read Mail.Read`. `Mail.ReadBasic` isn't enough because it excludes message bodies.

**OAuth flow:** `login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize`, then `/token`, using the same state handling as Gmail. Refresh tokens may be rotated by Microsoft, and the new one is saved.

**Imported:** messages grouped by `conversationId`: subject, sender, recipients, timestamps, and the text body (requested with `Prefer: outlook.body-content-type="text"`, quoted history removed). Attachment metadata via `/messages/{id}/attachments?$select=name,contentType,size`. Drafts are skipped. Messages from the support addresses are agent replies.

**Sync method:** `GET /me/messages` (default *All folders*, so Sent Items replies are included) or `/me/mailFolders/inbox/messages`, with `$filter=receivedDateTime ge {checkpoint}&$orderby=receivedDateTime asc&$top=50`. Paging follows `@odata.nextLink`. The checkpoint is the newest `receivedDateTime` with a 2-minute overlap.

**Rate limits:** Graph throttles per mailbox. 429 responses are retried after `Retry-After`.

**Limitations:** polling only (change notifications need subscription renewal). A shared mailbox is attributed to the mailbox, not an individual agent.

**Docs:** https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow · https://learn.microsoft.com/en-us/graph/api/user-list-messages?view=graph-rest-1.0 · https://learn.microsoft.com/en-us/graph/api/resources/message?view=graph-rest-1.0 · https://learn.microsoft.com/en-us/graph/throttling

---

## Sarvam AI (speech-to-text) and Anthropic Claude (AI analysis)

Both are API-key integrations configured on the same page. They import nothing. The processing pipeline calls them on demand to transcribe authorised recordings and to analyse conversations. Their adapters (`src/lib/providers/sarvam.ts`, `src/lib/providers/anthropic.ts`) document their own endpoints and limits.

## Optional: CSAT / order-management systems

None is connected yet. To add one, implement `ProviderDefinition` (`src/lib/providers/types.ts`) and list it in `src/lib/providers/registry.ts`. The Integrations page, encrypted credential storage, testing, webhook route, OAuth routes, sync runner and audit trail then work for it without further changes.

## Adding or debugging a connector

- **Adapters:** `src/lib/providers/*.ts`. Each one has pure mapping functions with tests in `tests/ingestion.test.ts` / `tests/webhooks.test.ts`, using fixtures in `tests/fixtures/`.
- **Ingestion:** `src/lib/ingestion/ingest.ts` (`ingestRecord`).
- **Connection service:** `src/lib/integrations/connections.ts`.
- **Sync runner:** `src/lib/integrations/sync.ts`.
- **Webhook intake:** `src/lib/integrations/webhooks.ts`.
- **Diagnostics on each card:** recent sync runs (`integration_sync_runs`), recent webhook deliveries with signature result and error (`webhook_events`), and failed jobs with a Retry button.
