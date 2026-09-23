-- THE-63: allow a multilingual embedding provider without mixing vector spaces.
-- Vectors stay 384-dimensional; each row already records its model. Search and the
-- discovery queue now compare/refresh only against the model the API is using.
create index if not exists tb_embeddings_model on public.tb_embeddings(model);

-- Replace (not overload) so PostgREST named-argument calls stay unambiguous.
drop function public.tb_match(extensions.vector,integer,boolean,boolean);
create function public.tb_match(query_embedding extensions.vector(384), match_count integer default 12, include_own boolean default true, include_discovery boolean default true, match_model text default null)
returns table(id text, score double precision, metadata jsonb, source text, data jsonb)
language sql stable set search_path = public, extensions as $$
  select e.video_id, 1 - (e.embedding <=> query_embedding), e.metadata, e.source, v.data
  from tb_embeddings e join tb_videos v on v.id=e.video_id
  where v.deleted_at is null and v.status <> 'rejected'
    and (match_model is null or e.model=match_model)
    and (include_discovery or e.source='board')
    and (include_own or coalesce((e.metadata->>'is_own')::boolean,false)=false)
  order by e.embedding <=> query_embedding limit least(greatest(match_count,1),50);
$$;

-- Discovery items with no vector, or a vector from another model, need enrichment.
create function public.tb_discovery_queue_for(current_model text)
returns table(id text, data jsonb) language sql stable set search_path = public as $$
  select v.id,v.data from tb_videos v
  where v.status='discovery' and v.deleted_at is null
    and not exists(select 1 from tb_embeddings e where e.video_id=v.id and e.model=current_model)
  order by v.position limit 100;
$$;

revoke execute on function public.tb_match(extensions.vector,integer,boolean,boolean,text), public.tb_discovery_queue_for(text) from public, anon, authenticated;
grant execute on function public.tb_match(extensions.vector,integer,boolean,boolean,text), public.tb_discovery_queue_for(text) to service_role;
