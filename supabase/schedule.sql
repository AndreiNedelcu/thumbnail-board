-- Run after deployment and after adding these two secrets in Supabase Vault:
-- tb_api_url = https://<project>.supabase.co/functions/v1/board-api
-- tb_auth_token = the board's new owner token (never the service_role key)
-- Existing jobs with the same names are updated by cron.schedule.
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
select cron.schedule('thumbnail-board-assets','* * * * *', $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name='tb_api_url') || '/api/maintenance/run',
    headers := jsonb_build_object('Content-Type','application/json','X-Auth-Token',(select decrypted_secret from vault.decrypted_secrets where name='tb_auth_token')),
    body := '{"limit":5}'::jsonb,
    timeout_milliseconds := 120000
  );
$$);
select cron.schedule('thumbnail-board-discovery','15 */6 * * *', $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name='tb_api_url') || '/api/scrape/run',
    headers := jsonb_build_object('Content-Type','application/json','X-Auth-Token',(select decrypted_secret from vault.decrypted_secrets where name='tb_auth_token')),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
$$);
