-- Normalize Client Simulator provider identity to clientId only.
-- When clientId is empty and legacy clientKey exists, copy clientKey → clientId.
-- When both exist and match, drop clientKey.
-- When both exist and differ, keep both and set clientIdConflict for operator review.

UPDATE autosnap_records
SET data = (data - 'clientKey') || jsonb_build_object('clientId', trim(both from data->>'clientKey')),
    updated_at = NOW()::text
WHERE kind = 'sim_provider'
  AND COALESCE(trim(both from data->>'clientId'), '') = ''
  AND COALESCE(trim(both from data->>'clientKey'), '') <> '';

UPDATE autosnap_records
SET data = data - 'clientKey',
    updated_at = NOW()::text
WHERE kind = 'sim_provider'
  AND COALESCE(trim(both from data->>'clientId'), '') <> ''
  AND COALESCE(trim(both from data->>'clientKey'), '') <> ''
  AND trim(both from data->>'clientId') = trim(both from data->>'clientKey');

UPDATE autosnap_records
SET data = data || jsonb_build_object('clientIdConflict', true),
    updated_at = NOW()::text
WHERE kind = 'sim_provider'
  AND COALESCE(trim(both from data->>'clientId'), '') <> ''
  AND COALESCE(trim(both from data->>'clientKey'), '') <> ''
  AND trim(both from data->>'clientId') <> trim(both from data->>'clientKey');
