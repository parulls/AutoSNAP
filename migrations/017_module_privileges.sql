-- Collapse CRUD and split privileges into module access without dropping a module already granted.
SET search_path TO autosnap, public;

UPDATE autosnap_users AS account
SET privileges = collapsed.keys
FROM (
  SELECT id,
    COALESCE(
      (
        SELECT jsonb_agg(module_key ORDER BY module_key)
        FROM (
          SELECT DISTINCT CASE entry
            WHEN 'dashboard' THEN 'dashboard'
            WHEN 'dev_site' THEN 'dev_site'
            WHEN 'dev_site_evidence' THEN 'dev_site'
            WHEN 'client_simulator' THEN 'client_simulator'
            WHEN 'client_simulator_manage' THEN 'client_simulator'
            WHEN 'master_data' THEN 'master_data'
            WHEN 'master_data_create' THEN 'master_data'
            WHEN 'master_data_update' THEN 'master_data'
            WHEN 'master_data_delete' THEN 'master_data'
            WHEN 'user_management' THEN 'user_management'
            WHEN 'user_management_create' THEN 'user_management'
            WHEN 'user_management_update' THEN 'user_management'
            WHEN 'user_management_delete' THEN 'user_management'
            WHEN 'history_all' THEN 'history_all'
            ELSE NULL
          END AS module_key
          FROM jsonb_array_elements_text(privileges) AS entry
        ) mapped
        WHERE module_key IS NOT NULL
      ),
      '[]'::jsonb
    ) AS keys
  FROM autosnap_users
  WHERE jsonb_typeof(privileges) = 'array'
) AS collapsed
WHERE account.id = collapsed.id
  AND account.privileges IS DISTINCT FROM collapsed.keys;
