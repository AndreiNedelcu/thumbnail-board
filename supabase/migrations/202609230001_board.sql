-- Board records and assets are independent of GitHub and YouTube availability.
create extension if not exists vector with schema extensions;

create table public.tb_videos (
  id text primary key check (id ~ '^[A-Za-z0-9_-]{11}$'),
  data jsonb not null check (jsonb_typeof(data) = 'object'),
  position bigint generated always as identity,
  status text not null default 'board' check (status in ('board','pending','inbox','discovery','rejected')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index tb_videos_status on public.tb_videos(status, created_at) where deleted_at is null;
create table public.tb_favorites (
  video_id text primary key references public.tb_videos(id),
  created_at timestamptz not null default now()
);
create table public.tb_settings (name text primary key, value jsonb not null);
create table public.tb_jobs (
  video_id text not null references public.tb_videos(id),
  kind text not null check(kind in ('archive','metadata')),
  attempts integer not null default 0,
  next_attempt timestamptz not null default now(),
  completed_at timestamptz,
  last_error text,
  primary key(video_id, kind)
);
create table public.tb_embeddings (
  video_id text primary key references public.tb_videos(id),
  embedding extensions.vector(384) not null,
  source text not null check(source in ('board','discovery')),
  model text not null default 'gte-small',
  metadata jsonb not null default '{}',
  updated_at timestamptz not null default now()
);
create index tb_embeddings_cosine on public.tb_embeddings using hnsw (embedding extensions.vector_cosine_ops);

-- Public reads and owner writes go through the API. No browser receives a service key.
alter table public.tb_videos enable row level security;
alter table public.tb_favorites enable row level security;
alter table public.tb_settings enable row level security;
alter table public.tb_jobs enable row level security;
alter table public.tb_embeddings enable row level security;
revoke all on public.tb_videos, public.tb_favorites, public.tb_settings, public.tb_jobs, public.tb_embeddings from anon, authenticated;
grant all on public.tb_videos, public.tb_favorites, public.tb_settings, public.tb_jobs, public.tb_embeddings to service_role;
grant usage, select on sequence public.tb_videos_position_seq to service_role;

create function public.tb_queue_assets() returns trigger language plpgsql set search_path = public as $$
begin
  if new.status in ('board','pending','inbox') and new.deleted_at is null then
    if coalesce(new.data->>'thumbnailUrl','') = '' then
      insert into tb_jobs(video_id,kind) values(new.id,'archive') on conflict do nothing;
    end if;
    if coalesce(new.data->>'channel','') = '' then
      insert into tb_jobs(video_id,kind) values(new.id,'metadata') on conflict do nothing;
    end if;
  end if;
  return new;
end $$;
create trigger tb_queue_assets after insert or update on public.tb_videos for each row execute function public.tb_queue_assets();

create function public.tb_save(items jsonb, mode text default 'add', destination text default 'board')
returns jsonb language plpgsql set search_path = public as $$
declare item jsonb; vid text; changed integer := 0; n integer; skipped integer := 0;
begin
  if jsonb_typeof(items) <> 'array' or destination not in ('board','pending','inbox','discovery','rejected') or mode not in ('add','update') then
    raise exception 'Invalid save parameters';
  end if;
  for item in select value from jsonb_array_elements(items) loop
    vid := coalesce(item->>'vid', item->>'id');
    if mode = 'update' then
      update tb_videos set data = data || (item - 'vid' - 'id'), updated_at = now()
        where id = vid and deleted_at is null;
    else
      insert into tb_videos(id,data,status) values(vid, (item - 'vid') || jsonb_build_object('id',vid), destination)
        on conflict(id) do update set
          data=tb_videos.data||excluded.data, status='board', updated_at=now()
        where tb_videos.status='pending' and tb_videos.deleted_at is null and destination='board';
    end if;
    get diagnostics n = row_count;
    changed := changed + n; skipped := skipped + (1 - n);
  end loop;
  return jsonb_build_object('ok',true,'changed',changed,'added',case when mode='add' then changed else 0 end,'updated',case when mode='update' then changed else 0 end,'skipped',skipped);
end $$;

create function public.tb_delete(ids text[]) returns jsonb language plpgsql set search_path = public as $$
declare removed text[];
begin
  -- Tombstones prevent a background tagger or scraper from resurrecting a deletion.
  update tb_videos set deleted_at = now(), updated_at = now() where id = any(ids) and deleted_at is null;
  select coalesce(array_agg(id), '{}') into removed from tb_videos where id=any(ids) and deleted_at is not null;
  delete from tb_favorites where video_id = any(removed);
  delete from tb_embeddings where video_id = any(removed);
  delete from tb_jobs where video_id = any(removed);
  return jsonb_build_object('ok',true,'deleted',cardinality(removed),'deletedIds',to_jsonb(removed));
end $$;

create function public.tb_decide(ids text[], destination text) returns jsonb language plpgsql set search_path = public as $$
declare n integer;
begin
  if destination not in ('board','pending','rejected') then raise exception 'Invalid destination'; end if;
  update tb_videos set status=destination, updated_at=now() where id=any(ids) and status='inbox' and deleted_at is null;
  get diagnostics n = row_count;
  return jsonb_build_object('ok',true,'moved',n,'destination',destination);
end $$;

create function public.tb_claim_jobs(batch_size integer default 5) returns setof tb_jobs language sql set search_path = public as $$
  update tb_jobs set next_attempt=now()+interval '5 minutes', attempts=attempts+1
  where (video_id,kind) in (
    select video_id,kind from tb_jobs where completed_at is null and next_attempt <= now() and attempts < 8
    order by next_attempt for update skip locked limit least(greatest(batch_size,1),10)
  ) returning *;
$$;

create function public.tb_match(query_embedding extensions.vector(384), match_count integer default 12, include_own boolean default true, include_discovery boolean default true)
returns table(id text, score double precision, metadata jsonb, source text, data jsonb)
language sql stable set search_path = public, extensions as $$
  select e.video_id, 1 - (e.embedding <=> query_embedding), e.metadata, e.source, v.data
  from tb_embeddings e join tb_videos v on v.id=e.video_id
  where v.deleted_at is null and v.status <> 'rejected'
    and (include_discovery or e.source='board')
    and (include_own or coalesce((e.metadata->>'is_own')::boolean,false)=false)
  order by e.embedding <=> query_embedding limit least(greatest(match_count,1),50);
$$;

revoke execute on function public.tb_save(jsonb,text,text), public.tb_delete(text[]), public.tb_decide(text[],text), public.tb_claim_jobs(integer), public.tb_match(extensions.vector,integer,boolean,boolean) from public, anon, authenticated;
grant execute on function public.tb_save(jsonb,text,text), public.tb_delete(text[]), public.tb_decide(text[],text), public.tb_claim_jobs(integer), public.tb_match(extensions.vector,integer,boolean,boolean) to service_role;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('thumbnails','thumbnails',true,5242880,array['image/jpeg','image/png','image/webp'])
on conflict(id) do nothing;
-- The bucket is readable as the existing public board is; uploads require service_role.

create function public.tb_collect(candidates jsonb, history jsonb, max_size integer default 100)
returns jsonb language plpgsql set search_path=public as $$
declare item jsonb; slots integer; n integer; added integer:=0;
begin
  perform pg_advisory_xact_lock(231026);
  for item in select value from jsonb_array_elements(history) loop
    insert into tb_videos(id,data,status) values(item->>'id',item,'discovery') on conflict do nothing;
  end loop;
  select greatest(0, least(max_size,500) - count(*)::integer) into slots from tb_videos where status='inbox' and deleted_at is null;
  for item in select value from jsonb_array_elements(candidates) loop
    exit when added>=slots;
    update tb_videos set status='inbox',data=data||item,updated_at=now()
      where id=item->>'id' and status='discovery' and deleted_at is null;
    get diagnostics n=row_count; added:=added+n;
  end loop;
  return jsonb_build_object('ok',true,'added',added,'capped',jsonb_array_length(candidates)-added);
end $$;

create function public.tb_register_image(vid text, patch jsonb) returns jsonb language plpgsql set search_path=public as $$
declare duplicate_id text;
begin
  perform pg_advisory_xact_lock(hashtext(patch->>'imageHash'));
  select id into duplicate_id from tb_videos where id<>vid and deleted_at is null
    and status in ('board','inbox') and data->>'imageHash'=patch->>'imageHash' order by position limit 1;
  update tb_videos set data=data||patch||case when duplicate_id is null then '{}'::jsonb else jsonb_build_object('duplicateOf',duplicate_id) end,
    status=case when duplicate_id is not null and status='inbox' then 'rejected' else status end,updated_at=now()
    where id=vid and deleted_at is null;
  return jsonb_build_object('ok',true,'duplicateOf',duplicate_id);
end $$;

revoke execute on function public.tb_collect(jsonb,jsonb,integer), public.tb_register_image(text,jsonb) from public, anon, authenticated;
grant execute on function public.tb_collect(jsonb,jsonb,integer), public.tb_register_image(text,jsonb) to service_role;

create function public.tb_block_channel(channel_id text, channel_name text default '') returns jsonb language plpgsql set search_path=public as $$
declare n integer;
begin
  perform pg_advisory_xact_lock(231027);
  insert into tb_settings(name,value) values('blocked_channels','[]') on conflict do nothing;
  update tb_settings set value=value||jsonb_build_array(jsonb_build_object('channelId',channel_id,'channel',channel_name))
    where name='blocked_channels' and not value @> jsonb_build_array(jsonb_build_object('channelId',channel_id));
  update tb_videos set status='rejected',updated_at=now() where status='inbox' and data->>'channelId'=channel_id;
  get diagnostics n=row_count;
  return jsonb_build_object('ok',true,'removed',n,'channelId',channel_id);
end $$;
revoke execute on function public.tb_block_channel(text,text) from public,anon,authenticated;
grant execute on function public.tb_block_channel(text,text) to service_role;

create view public.tb_discovery_queue with (security_invoker = true) as
  select v.id,v.data from public.tb_videos v
  where v.status='discovery' and v.deleted_at is null
    and not exists(select 1 from public.tb_embeddings e where e.video_id=v.id)
  order by v.position;
revoke all on public.tb_discovery_queue from anon,authenticated;
grant select on public.tb_discovery_queue to service_role;
