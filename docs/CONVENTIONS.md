# Codebase conventions (read before adding code)

Stack: Next.js 14 App Router + TypeScript, Tailwind, Recharts, `pg` (no ORM), Postgres (Supabase or any PG 15+).

## Data access
- `withOrg(orgId, db => ...)` (src/lib/db.ts) for EVERYTHING triggered by a user request. It runs as role `rsi_app` with RLS → org isolation.
- `withSystem(db => ...)` only for trusted system code: login lookup, webhook routing (before org is known), the worker loop.
- `db.query<T>(sql, params)`, `db.one<T>()`, `db.exec()` → rowCount. Use `$1` params; build dynamic filters with `SqlBuilder` (src/lib/sql.ts).
- Role data scope (all/team/own): `scopeInteractions(session, b, 'i')` / `scopeAgents(session, b, 'agent_id')` in src/lib/repos/scope.ts. Apply it to every interaction/flag/coaching/agent query.
- Every table has org_id; always insert `org_id`.
- New schema → new file in db/migrations/ (numbered), then `npx tsx scripts/migrate.ts`. Never edit an applied migration.
- After changing transcript/messages/labels of an interaction call `SELECT rsi_refresh_search_text($1)`.

## Auth & permissions
- Pages: `const s = await requirePermission('perm')` or `requireSession()` (src/lib/auth/session.ts).
- Server actions / route handlers: `const s = await assertPermission('perm')` (throws). Then `withOrg(s.org.id, ...)`.
- Audit sensitive actions: `auditAction(db, s, 'area.verb', 'target_type', id, details)`.
- Permissions list: src/lib/auth/rbac.ts. PII: mask phone/email with `maskPhone/maskEmail` unless `customer_pii.view`.
- Secrets: `encryptJson/decryptJson` (src/lib/crypto.ts). Never send decrypted secrets to the browser; show `maskSecret()`.

## UI
- Server components by default; client components only for interactivity ('use client').
- Never pass functions from server to client components (use string templates; see `fillTemplate` in charts.tsx).
- Constants used by both server and client must NOT live in a 'use client' file.
- Primitives: src/components/ui.tsx (PageHeader, Card, CardHeader, CardBody, Button, ButtonLink, Badge, DemoBadge, Table/THead/TBody + `.th`/`.td` classes, KpiCard, EmptyState, Notice, Field, KeyValue, SectionTitle).
- Badges: src/components/badges.tsx. Charts: src/components/charts.tsx (ChartCard with table toggle, StackedBars, Lines, ColumnBars, HBarList) + palette in src/lib/palette.ts. One y-axis only; no dual axes.
- URL-driven filters: src/components/filters.tsx (RangeFilter, ParamSelect, ParamSearch, ClearFilters); parse with src/lib/filters.ts (parseRange, parseChannel, parsePage, sp, spAll, withParams). Pagination: src/components/pagination.tsx.
- Formatting: src/lib/format.ts (fmtDateTime, fmtDuration, fmtPct, fmtNum, titleCase, relTime) — IST.
- Show `<DemoBadge/>` next to any record/aggregate where `is_demo` is true.
- Colours: brand #784900 / #A56312 / #E7E0CE; red only for critical, amber for warnings.
- Mutations: server actions in a colocated `actions.ts` ('use server'), validate with zod, `revalidatePath()` afterwards.

## Pipeline
- Queue: src/lib/pipeline/jobs.ts (`enqueue`, `enqueueProcessing`, `claimJobs`, `completeJob`, `failJob`, `retryJob`).
- Processing statuses on interactions: imported → transcription_pending → transcribing → analysis_pending → analyzing → completed | failed | requires_review.
- Scoring: src/lib/ai/scoring.ts (`computeScore`, `bandFor`, `weightsFor`).
- Notifications: src/lib/notify.ts.
