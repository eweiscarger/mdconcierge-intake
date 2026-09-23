-- pg_cron scheduling layer for the MDRx outreach engine.
-- Recovered from the live database and RE-RECORDED 23 Sep 2026 after changes made that day.
--
-- This layer exists in no other source file. It drives three GitHub workflows by calling
-- their workflow_dispatch API from Postgres, a workaround built after GitHub silently
-- de-registered every edited workflow schedule on 15 Sep 2026. Anyone reading
-- .github/workflows/ alone would wrongly conclude GitHub Actions is the only scheduler.
--
-- CHANGES 23 Sep 2026:
--   jobs 8/9  (mdc-send-tonight, mdc-send-tomorrow) one-off, fired and unscheduled.
--   jobs 10/11 (mdc-send-window, mdc-send-window-late) ADDED. The original send-window
--     triggers, jobs 3 and 4, were unscheduled on 17 Sep - the same day sending stopped -
--     leaving the 06:25-07:25 ET window single-homed on the GitHub scheduler, which this
--     system's own notes record as delivering 3 to 5 of 48 requested runs. Overlapping the
--     sender is safe: a row flips to 'sent' when it goes, so the second trigger finds
--     nothing due. CADENCE is the job that must never double-fire; do not duplicate it.

-- ============ FUNCTION DEFINITIONS ============

-- engine_cadence_tick
CREATE OR REPLACE FUNCTION public.engine_cadence_tick()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'cron'
AS $function$
declare v_token text; v_repo text;
begin
  select value into v_token from public.engine_config where key = 'gh_token';
  select value into v_repo  from public.engine_config where key = 'gh_repo';
  if v_token is null or v_token = '' or v_repo is null then
    raise notice 'engine_cadence_tick: no github token or repo, refusing to dispatch';
    return;
  end if;
  perform net.http_post(
    url := 'https://api.github.com/repos/' || v_repo || '/actions/workflows/cadence.yml/dispatches',
    headers := jsonb_build_object(
                 'Authorization', 'Bearer ' || v_token,
                 'Accept', 'application/vnd.github+json',
                 'X-GitHub-Api-Version', '2022-11-28',
                 'User-Agent', 'mdconcierge-engine',
                 'Content-Type', 'application/json'),
    body := jsonb_build_object('ref', 'main'));
end;
$function$
;


-- engine_dispatch
CREATE OR REPLACE FUNCTION public.engine_dispatch(p_workflow text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'cron'
AS $function$
declare v_token text; v_repo text;
begin
  select value into v_token from public.engine_config where key = 'gh_token';
  select value into v_repo  from public.engine_config where key = 'gh_repo';
  if v_token is null or v_token = '' or v_repo is null then
    raise notice 'engine_dispatch(%): no github token or repo, refusing', p_workflow;
    return;
  end if;
  perform net.http_post(
    url := 'https://api.github.com/repos/' || v_repo || '/actions/workflows/' || p_workflow || '/dispatches',
    headers := jsonb_build_object(
                 'Authorization', 'Bearer ' || v_token,
                 'Accept', 'application/vnd.github+json',
                 'X-GitHub-Api-Version', '2022-11-28',
                 'User-Agent', 'mdconcierge-engine',
                 'Content-Type', 'application/json'),
    body := jsonb_build_object('ref', 'main'));
end;
$function$
;


-- engine_send_tick
CREATE OR REPLACE FUNCTION public.engine_send_tick()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'cron'
AS $function$
declare v_secret text; v_anon text; v_url text;
begin
  select value into v_secret from public.engine_config where key = 'mdc_cron_secret';
  select value into v_anon   from public.engine_config where key = 'anon_key';
  select value into v_url    from public.engine_config where key = 'functions_url';
  if v_secret is null or v_secret = '' then
    raise notice 'engine_send_tick: no cron secret, refusing to call send-outreach';
    return;
  end if;
  if v_anon is null or v_url is null then
    raise notice 'engine_send_tick: anon_key or functions_url missing, refusing to call';
    return;
  end if;
  perform net.http_post(
    url := v_url || '/send-outreach',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || v_anon,'x-mdc-cron', v_secret),
    body := '{}'::jsonb);
end;
$function$
;

-- ============ SCHEDULED JOBS ============
-- job 5  active=True
select cron.schedule('engine-morning-cadence', '40 9 * * 1-5', $$
select public.engine_cadence_tick()
$$);

-- job 6  active=True
select cron.schedule('engine-desk', '50 11 * * 1-5', $$
select public.engine_dispatch('desk.yml')
$$);

-- job 7  active=True
select cron.schedule('engine-digest', '45 12 * * 1-5', $$
select public.engine_dispatch('morning-digest.yml')
$$);

-- job 10  active=True
select cron.schedule('mdc-send-window', '25,40,55 10 * * 1-5', $$
select net.http_post(
  url := (select value from public.engine_config where key='functions_url') || '/send-outreach',
  headers := jsonb_build_object(
      'Content-Type','application/json',
      'x-mdc-cron',(select value from public.engine_config where key='mdc_cron_secret')),
  body := '{}'::jsonb
);
$$);

-- job 11  active=True
select cron.schedule('mdc-send-window-late', '10,25 11 * * 1-5', $$
select net.http_post(
  url := (select value from public.engine_config where key='functions_url') || '/send-outreach',
  headers := jsonb_build_object(
      'Content-Type','application/json',
      'x-mdc-cron',(select value from public.engine_config where key='mdc_cron_secret')),
  body := '{}'::jsonb
);
$$);

-- ============ engine_config KEYS (values deliberately not dumped) ============
--   anon_key
--   functions_url
--   gh_repo
--   gh_token
--   mdc_cron_secret
--
-- NOTE: gh_token is a GitHub PAT with no recorded expiry. When it expires, jobs 5/6/7
-- stop dispatching silently and nothing reports it.