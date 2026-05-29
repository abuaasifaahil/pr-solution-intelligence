-- Seed 6 default skills. Idempotent — safe to re-run on every deploy.
INSERT INTO skills (id, name, description, type, handler_config, is_default, is_active, created_at)
VALUES
  (gen_random_uuid(), 'sentiment_analysis',   'Classifies content as positive / neutral / negative', 'analysis',    '{}'::jsonb, true, true, now()),
  (gen_random_uuid(), 'theme_classification', 'Tags content with a controlled set of topical themes', 'analysis',    '{}'::jsonb, true, true, now()),
  (gen_random_uuid(), 'emotion_detection',    'Detects discrete emotions (joy, anger, fear, sadness, surprise)', 'analysis', '{}'::jsonb, true, true, now()),
  (gen_random_uuid(), 'entity_extraction',    'Extracts people, organizations, locations, products from text', 'extraction', '{}'::jsonb, true, true, now()),
  (gen_random_uuid(), 'signal_detection',     'Flags crisis / virality / regulatory signals from a stream', 'detection', '{}'::jsonb, true, true, now()),
  (gen_random_uuid(), 'reach_analysis',       'Computes audience reach and engagement metrics per content piece', 'measurement', '{}'::jsonb, true, true, now())
ON CONFLICT (name) DO NOTHING;
