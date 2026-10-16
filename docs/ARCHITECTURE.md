# Architecture

```
            ┌────────────── Providers ──────────────┐
 MyOperator · LimeChat · WhatsApp Cloud · Gmail · M365      Sarvam (STT)   Claude (LLM)
            │ webhooks (signed)        │ polling (APIs)         ▲              ▲
            ▼                          ▼                        │              │
  /api/webhooks/{provider}/{token}   worker: sync jobs          │              │
     verify → webhook_events            │                       │              │
            └──────► webhook_process ───┤                       │              │
                                        ▼                       │              │
                         ingestion (idempotent upsert)          │              │
             interactions · calls · threads/messages · emails   │              │
                                        │ enqueueProcessing      │              │
                                        ▼                        │              │
                    transcribe job ──(recording, server-side)────┘              │
                                        ▼                                       │
                    analyze job ── conversation + approved KB + rubric ─────────┘
                                        ▼
         ai_analyses · quality_evaluations · issue labels · root causes
                                        ▼
                 alert engine (rules + SLA/business hours) → quality_flags → notifications
                                        ▼
        Next.js UI: dashboard · inbox · review queue · issues · agents · coaching · reports
```

## Layers (src/)

| Layer | Path | Responsibility |
|---|---|---|
| Provider adapters | `lib/providers/*` | One `ProviderDefinition` per service (`types.ts`): config/secret fields, scopes, `testConnection`, `fetchSince`, `handleWebhook`, OAuth. Server-only. |
| Integrations | `lib/integrations/*` | Connection CRUD (encrypted secrets), webhook routing, sync runner with checkpoints, OAuth state. |
| Ingestion | `lib/ingestion/*` | Maps `NormalizedInteraction` to tables. Idempotent on `(org_id, source_platform, source_record_id)`; messages dedupe on `(thread_id, external_message_id)`. |
| Pipeline | `lib/pipeline/*`, `scripts/worker.ts` | Postgres job queue (`FOR UPDATE SKIP LOCKED`, exponential backoff, dead-letter, stale-lock recovery), transcription, analysis, SLA checks, retention, email notifications. |
| AI | `lib/ai/*` | Prompt + strict JSON schema, zod validation, evidence-id mapping (flags without resolvable evidence are dropped), server-side scoring, alert engine, business-hours SLA maths, heuristic analyzer (demo data only), coaching drafts. |
| Repos | `lib/repos/*`, `lib/metrics/*` | SQL for every screen, always with role data scope. |
| Auth | `lib/auth/*` | Sessions, bcrypt, TOTP MFA, lockout, rate limiting, RBAC (permissions + data scope). |
| UI | `app/(app)/*`, `components/*` | Server components; client components only for interaction. URL-driven filters. |

## Processing statuses
`imported → transcription_pending → transcribing → analysis_pending → analyzing → completed`, or `failed` (with a human-readable error and a retry button) or `requires_review` (low confidence or missing/placeholder policy).

## Database
All tables are defined in `db/migrations/`: 0001 (schema), 0002 (RLS), 0003 (search helpers, KB placeholder flag), 0004 (OAuth states).

- **Keys and isolation:** UUID primary keys; `org_id` on every table; RLS policy `org_isolation` for the app role.
- **Provider IDs:** kept in `source_*` / `external_*` columns, separate from internal IDs.
- **Search:** `interactions.search_tsv` (generated tsvector, `simple` config for Hinglish) plus a trigram index on `search_text`, rebuilt by `rsi_refresh_search_text(id)`. Transcript segments have their own GIN index.
- **Source vs AI:** original content (`transcript_segments`, `conversation_messages`, `email_messages`) is never modified by AI. AI output lives in `ai_analyses` / `quality_evaluations` / labels. Human corrections are new rows (`evaluator_type='human'`, `source='human'`), with an audit trail in `reviewer_decisions`.
- **Policy versions:** every evaluation records the knowledge-base versions it used (`kb_version_ids`).

## Demo mode
`lib/demo/*` generates deterministic synthetic data, with every row marked `is_demo`. The UI shows DEMO DATA badges and a banner. Demo audio is never sent to providers. Reset or removal is available in System Settings (`demo.reset` permission).
