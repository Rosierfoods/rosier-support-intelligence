# Security, privacy & governance

## Authentication
- Email + password with bcrypt (cost 12). Minimum 10 characters, mixing letters and digits.
- Sessions use random 256-bit tokens; only a SHA-256 hash is stored. Cookies are httpOnly, SameSite=Lax and Secure in production. Expiry is 12 hours by default (`SESSION_HOURS`), sliding.
- **Two-factor (TOTP)** can be turned on per user under Profile & security. The secret is encrypted at rest. Admins can reset it from Team Management.
- Lockout after 5 failed attempts (15 minutes), plus per-IP and per-account rate limits on sign-in and MFA. Unknown accounts take the same time to fail as known ones.
- Changing a password revokes the user's other sessions. Admins can revoke any session from Audit Logs & Security.

## Authorisation
- Five roles, each with a default permission set (`src/lib/auth/rbac.ts`). A Super Admin can override permissions per role; the Super Admin role itself can't be locked out, and the last active Super Admin can't be removed.
- **Data scope:** Team Leaders see only their team's interactions; Support Agents see only their own. This is enforced in every query.
- Customer phone numbers and emails are masked unless the role has `customer_pii.view`. CSV exports mask them too.
- **Organisation isolation** is enforced in Postgres by forced row-level security: requests run as `rsi_app` with `app.org_id` set. Supabase `anon`/`authenticated` roles have no grants.

## Secrets
- Integration credentials, OAuth tokens and MFA secrets are encrypted with AES-256-GCM (`SECRETS_ENCRYPTION_KEY`).
- They are never sent to the browser. The UI shows masked values such as `••••1234`, and blank fields keep the stored value.
- All provider calls happen server-side, and errors are trimmed so they never echo credentials.
- Webhooks are verified: Meta `X-Hub-Signature-256` HMAC, LimeChat/Chatwoot `X-Chatwoot-Signature` HMAC with a 5-minute replay window, MyOperator header or HMAC. Where a provider doesn't sign, a shared key is compared in constant time. Bodies are capped at 1 MB and requests are rate limited per token. Stored headers have their auth values stripped. Duplicate events are acknowledged and ignored.
- The recording proxy refuses private and loopback addresses (SSRF guard) and never exposes the provider URL.

## Audit trail
`audit_logs` records the following, with user, IP and user agent:

- sign-ins, failed sign-ins, MFA events
- configuration changes: integrations (never their secret values), AI config, knowledge base, team, permissions, settings
- exports, with filter summary and row count
- recording playback
- reviewer decisions and demo resets

## AI governance
- AI scores and flags are labelled as AI interpretations and shown alongside their evidence. They are **potential concerns** until a human confirms them.
- No disciplinary action is automated. Coaching requires human verification of the flag first.
- The AI uses only *published, non-placeholder* knowledge-base versions for live data. When a policy is missing or contradictory, it flags uncertainty and routes the interaction to human review instead of inventing rules.
- The model's arithmetic is never trusted: scores are computed server-side. Flags whose evidence can't be located in the source conversation are discarded.
- Root causes produced by the AI are stored as *suspected / AI inference* until a reviewer confirms them.

## Privacy & retention
- Retention periods are configurable in System Settings: recordings, transcripts, messages, customer PII and audit logs. The worker enforces them daily and logs what it removed.
- Recording copies are retained only when storage is configured. Otherwise recordings are streamed from the provider on demand, for authorised roles only.
- Optional org setting `privacy.storeCustomerContact=false` stores only hashed phone and email.
- **Consent:** make sure call-recording notices and customer privacy terms cover transcription and AI analysis before connecting live data. This platform processes data as configured; it doesn't establish consent itself.

## HTTP
Responses set `X-Frame-Options: DENY`, `nosniff`, a strict referrer policy, HSTS and a restrictive Permissions-Policy. Server actions get Next.js origin checks.
