-- Board speed: one query returns a whole list (PostgREST caps plain selects at 1,000
-- rows, which forced several sequential round trips per page load).
create function public.tb_list(list_status text) returns jsonb
language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(v.data || jsonb_build_object('id', v.id) order by v.position), '[]'::jsonb)
  from tb_videos v where v.status = list_status and v.deleted_at is null;
$$;
revoke execute on function public.tb_list(text) from public, anon, authenticated;
grant execute on function public.tb_list(text) to service_role;

-- Approved items join the end of the board (like the old data.json append), so
-- "Recent" shows them first. Same behaviour as before otherwise.
create or replace function public.tb_decide(ids text[], destination text) returns jsonb language plpgsql set search_path = public as $$
declare n integer;
begin
  if destination not in ('board','pending','rejected') then raise exception 'Invalid destination'; end if;
  if destination='board' then
    update tb_videos set status='board', updated_at=now(), position=default, data=data||jsonb_build_object('approvedAt',now())
      where id=any(ids) and status='inbox' and deleted_at is null;
  else
    update tb_videos set status=destination, updated_at=now()
      where id=any(ids) and status='inbox' and deleted_at is null;
  end if;
  get diagnostics n = row_count;
  return jsonb_build_object('ok',true,'moved',n,'destination',destination);
end $$;

create or replace function public.tb_save(items jsonb, mode text default 'add', destination text default 'board')
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
      n := 0;
      if destination = 'board' then
        -- A tagged pending item is published at the end of the board.
        update tb_videos set data=data||(item - 'vid' - 'id')||jsonb_build_object('approvedAt',now()), status='board', updated_at=now(), position=default
          where id=vid and status='pending' and deleted_at is null;
        get diagnostics n = row_count;
      end if;
      if n = 0 then
        insert into tb_videos(id,data,status) values(vid, (item - 'vid') || jsonb_build_object('id',vid), destination)
          on conflict(id) do nothing;
      end if;
    end if;
    get diagnostics n = row_count;
    changed := changed + n; skipped := skipped + (1 - n);
  end loop;
  return jsonb_build_object('ok',true,'changed',changed,'added',case when mode='add' then changed else 0 end,'updated',case when mode='update' then changed else 0 end,'skipped',skipped);
end $$;

-- Publish approved-but-untagged items waiting for the Mac tagger (status pending).
create function public.tb_publish_pending(ids text[]) returns jsonb language plpgsql set search_path = public as $$
declare n integer;
begin
  update tb_videos set status='board', updated_at=now(), position=default,
      data=data||jsonb_build_object('approvedAt',now())
    where id=any(ids) and status='pending' and deleted_at is null;
  get diagnostics n = row_count;
  return jsonb_build_object('ok',true,'moved',n,'destination','board');
end $$;
revoke execute on function public.tb_publish_pending(text[]) from public, anon, authenticated;
grant execute on function public.tb_publish_pending(text[]) to service_role;

-- Inbox approvals now go straight to the board untagged. The Mac tagger fills in
-- tags later, but only while the item still has none: never overwrites user edits.
create function public.tb_tag_untagged(items jsonb) returns jsonb language plpgsql set search_path = public as $$
declare item jsonb; n integer; changed integer := 0;
begin
  for item in select value from jsonb_array_elements(items) loop
    if jsonb_typeof(item->'tags') <> 'array' or jsonb_array_length(item->'tags') = 0 then continue; end if;
    update tb_videos set data = data || jsonb_build_object('tags', item->'tags', 'autoTaggedAt', now()), updated_at = now()
      where id = item->>'id' and status = 'board' and deleted_at is null
        and coalesce(jsonb_array_length(case when jsonb_typeof(data->'tags')='array' then data->'tags' end), 0) = 0;
    get diagnostics n = row_count;
    changed := changed + n;
  end loop;
  return jsonb_build_object('ok', true, 'changed', changed, 'skipped', jsonb_array_length(items) - changed);
end $$;
revoke execute on function public.tb_tag_untagged(jsonb) from public, anon, authenticated;
grant execute on function public.tb_tag_untagged(jsonb) to service_role;
