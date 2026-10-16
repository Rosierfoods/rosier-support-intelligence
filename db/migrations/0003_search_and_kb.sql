-- Placeholder (template/demo) policy text must never be treated as approved policy for live data.
ALTER TABLE knowledge_base_versions ADD COLUMN is_placeholder boolean NOT NULL DEFAULT false;

-- Rebuild the searchable text for one interaction from all its source content and labels.
CREATE OR REPLACE FUNCTION rsi_refresh_search_text(p_id uuid) RETURNS void LANGUAGE sql AS $$
  UPDATE interactions i SET search_text = left(concat_ws(' ',
    i.ref, i.subject, i.preview, i.product, i.ai_summary, i.customer_intent,
    (SELECT a.name FROM agents a WHERE a.id = i.agent_id),
    (SELECT string_agg(s.text || coalesce(' ' || s.text_en, ''), ' ' ORDER BY s.seq)
       FROM transcript_segments s JOIN call_transcripts t ON t.id = s.transcript_id AND t.is_current
      WHERE s.interaction_id = i.id),
    (SELECT string_agg(m.body, ' ' ORDER BY m.seq) FROM conversation_messages m WHERE m.interaction_id = i.id),
    (SELECT string_agg(coalesce(e.subject, '') || ' ' || e.body_text, ' ' ORDER BY e.seq) FROM email_messages e WHERE e.interaction_id = i.id),
    (SELECT string_agg(c.name || ' ' || coalesce(sc.name, ''), ' ')
       FROM interaction_issue_labels l JOIN issue_categories c ON c.id = l.category_id
       LEFT JOIN issue_categories sc ON sc.id = l.subcategory_id
      WHERE l.interaction_id = i.id AND l.is_active)
  ), 200000)
  WHERE i.id = p_id;
$$;

-- Repeat-contact indicator: same customer contacted again within N days of a previous interaction.
CREATE OR REPLACE FUNCTION rsi_recompute_repeat_contacts(p_days int) RETURNS void LANGUAGE sql AS $$
  UPDATE interactions i SET is_repeat_contact = EXISTS (
    SELECT 1 FROM interactions p
     WHERE p.org_id = i.org_id AND p.customer_id = i.customer_id AND p.id <> i.id
       AND p.occurred_at < i.occurred_at AND p.occurred_at >= i.occurred_at - make_interval(days => p_days))
  WHERE i.customer_id IS NOT NULL AND i.org_id = rsi_current_org();
$$;

GRANT EXECUTE ON FUNCTION rsi_refresh_search_text(uuid) TO rsi_app;
GRANT EXECUTE ON FUNCTION rsi_recompute_repeat_contacts(int) TO rsi_app;
GRANT EXECUTE ON FUNCTION rsi_current_org() TO rsi_app;
