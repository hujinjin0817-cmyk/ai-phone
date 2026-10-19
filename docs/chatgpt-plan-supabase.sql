-- AI Phone · ChatGPT account credential store
-- Run once in the personal Supabase project's SQL Editor.
-- Only service_role can call these functions. The OAuth credential is encrypted
-- at rest by Supabase Vault and never exposed to anon/authenticated roles.

create extension if not exists supabase_vault with schema vault;

create or replace function public.ai_phone_get_chatgpt_credential()
returns jsonb
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  result jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended('ai_phone_chatgpt_oauth', 0));

  select decrypted_secret::jsonb
    into result
    from vault.decrypted_secrets
   where name = 'ai_phone_chatgpt_oauth'
   order by created_at desc
   limit 1;
  return result;
end;
$$;

create or replace function public.ai_phone_set_chatgpt_credential(
  p_credential jsonb,
  p_expected_refresh_token text default null
)
returns boolean
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  secret_id uuid;
  current_refresh_token text;
begin
  if coalesce(p_credential->>'access_token', '') = ''
     or coalesce(p_credential->>'refresh_token', '') = ''
     or coalesce(p_credential->>'client_id', '') = ''
     or coalesce((p_credential->>'expires_at')::bigint, 0) <= 0 then
    raise exception 'invalid ChatGPT OAuth credential';
  end if;

  select id, decrypted_secret::jsonb->>'refresh_token'
    into secret_id, current_refresh_token
    from vault.decrypted_secrets
   where name = 'ai_phone_chatgpt_oauth'
   order by created_at desc
   limit 1;

  if secret_id is null then
    if p_expected_refresh_token is not null then return false; end if;
    perform vault.create_secret(p_credential::text, 'ai_phone_chatgpt_oauth', 'AI Phone ChatGPT OAuth credential');
    return true;
  end if;

  if p_expected_refresh_token is not null
     and current_refresh_token is distinct from p_expected_refresh_token then
    return false;
  end if;

  perform vault.update_secret(secret_id, p_credential::text);
  return true;
end;
$$;

revoke all on function public.ai_phone_get_chatgpt_credential() from public, anon, authenticated;
revoke all on function public.ai_phone_set_chatgpt_credential(jsonb, text) from public, anon, authenticated;
grant execute on function public.ai_phone_get_chatgpt_credential() to service_role;
grant execute on function public.ai_phone_set_chatgpt_credential(jsonb, text) to service_role;
