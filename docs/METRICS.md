# Metric definitions

Every number in the app is computed from stored database records at request time. The same definitions are shown as ⓘ tooltips next to each KPI. This file is generated from the definitions in the code, so the two cannot drift apart.

**Common rules**

- **In range** means `interactions.occurred_at` falls within the selected date range (IST presets or a custom range). The channel/team/agent filters and the viewer's **role data scope** are then applied: Super Admin, CRM Manager and Quality Analyst see everything; a Team Leader sees their team; a Support Agent sees their own interactions.
- **Complaint** means an interaction with at least one active issue label in any category except *Product Information* and *Other*.
- **Quality score** is calculated as follows. Each criterion is scored 0–5 or marked N/A. A group's score is the mean of its applicable criteria ÷ 5 × the group weight. The overall score is the sum of applicable group scores ÷ the sum of applicable group weights × 100, so N/A criteria never penalise the agent. Default weights: Communication & empathy 20, Problem understanding 15, Information accuracy 20, Policy compliance 20, Resolution & ownership 15, Closure & clarity 10. Weights are configurable per channel in AI Configuration. If a human correction exists, it replaces the AI score.
- **Score bands** (configurable): 90–100 Excellent · 80–89 Good · 70–79 Needs improvement · below 70 Requires review. The review threshold (default 70) drives the *AI quality failure rate*.
- **Repeat contact** means the same customer record contacted again within the repeat-contact window (default 7 days).
- **SLA / delay** calculations count only business hours (default Mon–Sat 09:30–18:30 IST) and use the per-channel first-response SLA (defaults: chat/WhatsApp 15 min, email 240 min). A conversation is never flagged just because a reply is still within SLA.
- **Period comparisons** compare the selected window with the immediately preceding window of equal length, under the same filters. They are only stated when the sample is large enough, and they always show sample sizes and dates.

## Overview dashboard

| Metric | Definition |
|---|---|
| `calls_received` | Count of inbound call interactions in range. |
| `calls_answered` | Inbound calls whose call_status = answered. |
| `missed_calls` | Inbound calls whose call_status = missed (provider-reported). |
| `whatsapp` | Count of WhatsApp conversations (threads) in range. |
| `emails` | Count of email threads in range. |
| `total` | All interactions in range across channels. |
| `avg_first_response` | Mean of first_response_seconds for chat, WhatsApp and email threads (time from the first customer message to the first agent reply). Calls use ring time and are shown separately. |
| `avg_resolution` | Mean of resolution_seconds for interactions with resolution_status = resolved. |
| `csat` | Mean CSAT (1–5) from customer_feedback linked to interactions in range. Shown only when feedback exists. |
| `fcr` | Resolved interactions with no further contact from the same customer within the repeat-contact window (default 7 days) and not reopened ÷ all resolved interactions. |
| `reopened` | Interactions flagged reopened ÷ interactions that reached resolved or were reopened. |
| `quality_failure` | Interactions whose current quality score is below the review threshold (default 70) ÷ interactions with a quality score. |
| `pending_complaints` | Interactions in open / pending / escalated / unresolved status that carry at least one complaint label (any category except Product Information and Other). |
| `open_critical` | Critical quality flags with status New, Under review or Confirmed (all dates). |
| `quality_score` | Mean current quality score (0–100) of evaluated interactions in range. |
| `refunds` | Interactions with at least one active Refund label. |
| `replacements` | Interactions with at least one active Replacement label. |

## Customer issues & root causes

| Metric | Definition |
|---|---|
| `refunds` | Distinct interactions in range with at least one active Refund label. |
| `replacements` | Distinct interactions in range with at least one active Replacement label. |
| `ghee_leak` | Distinct interactions with an active "Ghee jar leaking" label (quality.ghee_leak). |
| `damaged` | Distinct interactions with an active Damaged product (replacement.damaged), Packaging damage (quality.packaging_damage) or Broken/cracked ghee jar (quality.ghee_broken) label. |
| `delivery` | Distinct interactions with at least one active Delivery label. |
| `fcr` | Resolved complaint interactions that were not reopened and had no further contact from the same customer within the repeat-contact window ÷ all resolved complaint interactions. Complaint = any category except Product Information and Other. |
| `avg_resolution` | Mean resolution_seconds of resolved complaint interactions in range. |
| `repeat` | Customers (matched by stored customer record) with two or more complaint interactions in range. Interactions without a customer record are excluded, so this is a lower bound. |
| `refund_value` | Sum of refund_amount on active labels whose refund_amount_source is set (i.e. backed by a financial record). Never estimated. |
| `pareto` | Subcategories ranked by distinct complaint interactions; cumulative % = running total ÷ sum of all subcategory counts (an interaction with two subcategories counts in both). |
| `comparison` | Distinct interactions with the label in the current window vs the immediately preceding window of equal length, same filters. A statement is generated only when the current window has ≥10 and the previous window ≥5 interactions. |

## Agent performance

| Metric | Definition |
|---|---|
| `calls` | Call interactions assigned to the agent in range. |
| `chats` | Chat and WhatsApp conversations assigned to the agent in range. |
| `emails` | Email threads assigned to the agent in range. |
| `missed` | Missed calls assigned to the agent + chat/WhatsApp/email threads still awaiting an agent reply longer than the channel first-response SLA (unresolved only). Only counted where assignment data exists. |
| `frt` | Mean first_response_seconds for chat, WhatsApp and email (first customer message → first agent reply). |
| `resolution` | Mean resolution_seconds of resolved interactions. |
| `quality` | Mean current quality score (0–100) of evaluated interactions. Hidden when fewer than 5 evaluations (n shown). |
| `fcr` | Resolved interactions not reopened and with no further contact from the same customer within the repeat-contact window ÷ resolved interactions. |
| `reopened` | Interactions marked reopened ÷ interactions that were resolved or reopened. |
| `csat` | Mean CSAT (1–5) from customer feedback on the agent’s interactions. Shown only when feedback exists. |
| `policy` | Mean of the Policy compliance group score as a % of its weight, from the current evaluation of each interaction (human evaluation preferred over AI). Policy-N/A interactions excluded. |
| `confirmed` | Quality flags on the agent’s in-range interactions that a reviewer confirmed (confirmed, coaching assigned or resolved). |
| `fp_rate` | Flags marked false positive ÷ all reviewed flags (confirmed + coaching assigned + resolved + false positive). High values point at the AI, not the agent. |
| `coaching` | Coaching actions created for the agent in range (excluding drafts and cancelled). |
| `improvement` | Mean quality score in range minus mean quality score in the previous period of equal length (same filters). Shown when both periods have ≥5 evaluations. |
| `complexity` | Case mix: share of interactions carrying a high/critical-severity label or a complaint label, and mean active issue labels per interaction. |

## Coaching effectiveness

| Metric | Definition |
|---|---|
| `completion` | Coaching actions completed or reviewed ÷ all non-cancelled, non-draft actions in your scope. |
| `improved` | Reviewed actions with outcome "improved" ÷ reviewed actions with an outcome. |
| `delta` | Mean (measured value at review − baseline) for reviewed actions where both are recorded. Both on a 0–100 scale. |
| `overdue` | Open actions (or completed but not yet reviewed) whose review date is in the past. |
| `measured` | Mean of the target metric on the agent’s interactions that occurred after the coaching was assigned. quality_score = overall score (0–100); a criterion code = that criterion’s mean score converted to 0–100 (score ÷ 5 × 100). Current evaluations only (human preferred over AI). |

## AI quality monitoring (alerts)

| Metric | Definition |
|---|---|
| `open` | Alerts currently New, Under review or Confirmed (any creation date), within your data scope and the other filters. |
| `newInRange` | Alerts created in the selected date range. |
| `confirmedRate` | Of alerts created in range that a reviewer has decided (Confirmed, Coaching assigned, Resolved or False positive): share not marked False positive. |
| `fpRate` | Of alerts created in range that a reviewer has decided: share marked False positive. |
