-- S36 core. Construction only: deployment and PostgreSQL execution remain deferred.
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- JavaScript canonicalJson orders UTF-16 code units, not database locale/code points.
create function public.utf16_key(s text) returns integer[] language plpgsql immutable strict set search_path = public, pg_temp as $$
declare out_key integer[] := '{}'; c integer; i integer;
begin
  for i in 1..char_length(s) loop
    c := ascii(substr(s,i,1));
    if c > 65535 then out_key := out_key || (55296 + ((c-65536)/1024)) || (56320 + ((c-65536)%1024));
    else out_key := out_key || c; end if;
  end loop;
  return out_key;
end $$;
create function public.normalize_text(s text) returns text language sql immutable strict set search_path = public, pg_temp as $$
  select regexp_replace(replace(replace(normalize(s,NFC), E'\r\n', E'\n'), E'\r', E'\n'),
    U&'[\0009\000B\000C\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]+$', '', 'gn');
$$;
create function public.normalize_json(v jsonb) returns jsonb language plpgsql immutable strict set search_path = public, pg_temp as $$
declare result jsonb; x record;
begin
  case jsonb_typeof(v)
  when 'string' then return to_jsonb(normalize_text(v #>> '{}'));
  when 'array' then select coalesce(jsonb_agg(normalize_json(value) order by ord), '[]') into result from jsonb_array_elements(v) with ordinality a(value,ord); return result;
  when 'object' then
    result := '{}'; for x in select * from jsonb_each(v) loop result := result || jsonb_build_object(normalize(x.key,NFC),normalize_json(x.value)); end loop; return result;
  else return v;
  end case;
end $$;
create function public.canonical_json(v jsonb) returns text language plpgsql immutable strict set search_path = public, pg_temp set extra_float_digits = 3 as $$
declare result text; n numeric; f text; expo integer; mant text;
begin
  case jsonb_typeof(v)
  when 'object' then select '{'||coalesce(string_agg(to_jsonb(key)::text||':'||canonical_json(value),',' order by utf16_key(key)),'')||'}' into result from jsonb_each(v); return result;
  when 'array' then select '['||coalesce(string_agg(canonical_json(value),',' order by ord),'')||']' into result from jsonb_array_elements(v) with ordinality a(value,ord); return result;
  when 'number' then
    n := (v::text)::numeric; if n=0 then return '0'; end if;
    -- float8 uses PostgreSQL's shortest round-trip conversion, as ECMAScript does.
    f := (n::double precision)::text;
    if abs(n)>=0.000001 and abs(n)<1e21 then
      f := (f::numeric)::text; if position('.' in f)>0 then f := rtrim(rtrim(f,'0'),'.'); end if; return f;
    end if;
    if position('e' in f)=0 then
      expo := floor(log(abs(n)))::integer; mant := (n / power(10::numeric,expo))::text;
      mant := rtrim(rtrim(mant,'0'),'.'); f := mant||'e'||case when expo>=0 then '+' else '-' end||abs(expo)::text;
    else
      mant := split_part(f,'e',1); expo := split_part(f,'e',2)::integer;
      f := mant||'e'||case when expo>=0 then '+' else '-' end||abs(expo)::text;
    end if; return f;
  else return v::text;
  end case;
end $$;
create function public.canonical_hash(v jsonb) returns text language sql immutable strict set search_path = public, pg_temp as $$
  select encode(extensions.digest(convert_to(canonical_json(normalize_json(v)),'UTF8'),'sha256'),'hex');
$$;
create function public.owner_uid() returns uuid language plpgsql stable security definer set search_path = public, pg_temp as $$
begin if auth.uid() is null then raise exception 'unauthenticated: sign in required'; end if; return auth.uid(); end $$;
create function public.require_service() returns void language plpgsql stable security definer set search_path = public, pg_temp as $$
begin if coalesce(auth.role(),'') <> 'service_role' then raise exception 'forbidden: service role required'; end if; end $$;
create function public.append_only() returns trigger language plpgsql set search_path = public, pg_temp as $$
begin raise exception 'immutable: % is insert-only', TG_TABLE_NAME; end $$;
create function public.valid_scale(s jsonb) returns boolean language plpgsql immutable set search_path = public, pg_temp as $$
declare x jsonb; prev numeric := null; n numeric;
begin
  if jsonb_typeof(s->'levels') is distinct from 'array' or jsonb_array_length(s->'levels') not between 2 and 7 then return false; end if;
  for x in select value from jsonb_array_elements(s->'levels') loop
    if jsonb_typeof(x->'value') is distinct from 'number' or jsonb_typeof(x->'label') is distinct from 'string' then return false; end if;
    n := (x->>'value')::numeric; if n<>trunc(n) or (prev is not null and n<=prev) or octet_length(x->>'label')>20480 then return false; end if; prev:=n;
  end loop; return true;
end $$;
create table public.gold_sets (
  id text primary key default gen_random_uuid()::text, owner_id uuid not null references auth.users(id), name text not null check(octet_length(name)<=20480),
  scale jsonb not null check(valid_scale(scale)), split_seed bigint not null check(split_seed between 0 and 4294967295),
  heldout_fraction numeric not null default 0.5 check(heldout_fraction>0 and heldout_fraction<1), split_algo_version text not null default 'stratified-group-greedy/v1' check(split_algo_version='stratified-group-greedy/v1'),
  content_hash text not null, annotation_hash text not null, split_hash text, frozen_at timestamptz, parent_set_id text references public.gold_sets(id),
  import_report jsonb not null, split_manifest jsonb, inherited_contamination boolean not null default false, created_at timestamptz not null default clock_timestamp()
);
create table public.items (
  set_id text not null references public.gold_sets(id), item_key text not null check(length(item_key)>0 and octet_length(item_key)<=20480), fingerprint text not null,
  group_key text, task_text text not null check(octet_length(task_text)<=20480), answer text not null check(octet_length(answer)<=20480),
  source text check(octet_length(source)<=20480), facts jsonb not null default '[]' check(jsonb_typeof(facts)='array'), split text check(split in ('dev','heldout')),
  primary key(set_id,item_key)
);
create table public.annotations_staging (set_id text not null, item_key text not null, annotator_id text not null check(length(annotator_id)>0 and octet_length(annotator_id)<=20480), score integer not null check(score>=0), primary key(set_id,item_key,annotator_id), foreign key(set_id,item_key) references public.items(set_id,item_key));
create table public.dev_annotations (like public.annotations_staging including defaults including constraints including indexes);
alter table public.dev_annotations add foreign key(set_id,item_key) references public.items(set_id,item_key);
create table public.heldout_annotations (like public.annotations_staging including defaults including constraints including indexes);
alter table public.heldout_annotations add foreign key(set_id,item_key) references public.items(set_id,item_key);
create table public.probe_pairs (set_id text not null references public.gold_sets(id), id text not null, payload jsonb not null, rejected boolean not null default false, primary key(set_id,id));
create table public.injection_items (set_id text not null references public.gold_sets(id), id text not null, payload jsonb not null, primary key(set_id,id));
create table public.rubric_versions (
  id text primary key default gen_random_uuid()::text, set_id text not null references public.gold_sets(id), parent_id text references public.rubric_versions(id), version integer not null check(version>0),
  instructions text not null check(octet_length(instructions)<=20480), levels jsonb not null check(jsonb_typeof(levels)='array'), change_note text not null default '', content_hash text not null,
  unique(set_id,content_hash)
);
create table public.judge_configs (
  id text primary key default gen_random_uuid()::text, owner_id uuid not null references auth.users(id), provider text not null check(provider in ('anthropic','openai_compatible','typesafe','mock')),
  model text not null check(length(model)>0 and octet_length(model)<=20480), params jsonb not null check(jsonb_typeof(params->'maxOutputTokens') is not distinct from 'number' and (params->>'maxOutputTokens')::numeric=trunc((params->>'maxOutputTokens')::numeric) and (params->>'maxOutputTokens')::numeric between 1 and 1000000),
  prompt_template_version text not null, output_schema_version text not null, score_readout text not null check(score_readout in ('json_score','argmax_probabilities','rounded_score')), level_map_version text not null, config_hash text not null,
  unique(owner_id,config_hash)
);
create table public.runs (
  id text primary key default gen_random_uuid()::text, owner_id uuid not null references auth.users(id), set_id text not null references public.gold_sets(id), rubric_id text not null references public.rubric_versions(id), judge_config_id text not null references public.judge_configs(id),
  split text not null check(split in ('dev','heldout')), kind text not null default 'score' check(kind in ('score','repeat','order','verbosity','injection')), heldout_look_id uuid,
  status text not null default 'pending' check(status in ('pending','running','paused','complete','failed')), planned_calls integer not null default 0 check(planned_calls>=0), completed_calls integer not null default 0 check(completed_calls>=0),
  score_items integer not null default 0, completed_score_items integer not null default 0, worst_case_usd numeric not null default 0 check(worst_case_usd>=0), lease_until timestamptz, claim_token bigint not null default 0,
  result_hash text, plan jsonb not null default '{}', include_probes boolean not null default false, jobs_installed boolean not null default false,
  created_at timestamptz not null default clock_timestamp(), completed_at timestamptz, prereg_id text, error jsonb
);
create table public.run_jobs (
  run_id text not null references public.runs(id), id text not null, item_key text not null, replicate integer not null check(replicate>=0), ledger_replicate integer not null check(ledger_replicate>=0),
  kind text not null check(kind in ('score','repeat','order','verbosity','injection')), payload jsonb not null, primary key(run_id,id,ledger_replicate)
);
create table public.verdicts (
  id uuid primary key default gen_random_uuid(), run_id text not null, item_key text not null, replicate integer not null check(replicate>=0), score integer check(score>=0),
  unusable_reason text check(unusable_reason in ('malformed_json','extra_keys','missing_score','non_integer','out_of_scale','empty','provider_error','timeout')), raw text not null,
  attempt_id text not null unique, created_at timestamptz not null default clock_timestamp(),
  check((score is null) <> (unusable_reason is null)), unique(run_id,item_key,replicate), foreign key(run_id,item_key,replicate) references public.run_jobs(run_id,id,ledger_replicate)
);

create function public.owns_set(s text) returns boolean language sql stable security definer set search_path = public, pg_temp as $$ select exists(select 1 from gold_sets where id=s and owner_id=auth.uid()); $$;
create function public.frozen_guard() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare s text; k integer;
begin
  if TG_TABLE_NAME='gold_sets' then
    if TG_OP<>'INSERT' and OLD.frozen_at is not null then raise exception 'frozen: gold set cannot change'; end if;
    if TG_OP='DELETE' then return OLD; end if;
    if NEW.parent_set_id is not null and not exists(select 1 from gold_sets where id=NEW.parent_set_id and owner_id=NEW.owner_id) then raise exception 'forbidden: parent set owner mismatch'; end if;
    return NEW;
  end if;
  s:=case when TG_OP='DELETE' then OLD.set_id else NEW.set_id end;
  if exists(select 1 from gold_sets where id=s and frozen_at is not null) then raise exception 'frozen: set inputs cannot change'; end if;
  if TG_OP='UPDATE' and NEW.set_id<>OLD.set_id and exists(select 1 from gold_sets where id=OLD.set_id and frozen_at is not null) then raise exception 'frozen: source set cannot change'; end if;
  if TG_OP<>'DELETE' and TG_TABLE_NAME in ('annotations_staging','dev_annotations','heldout_annotations') then
    NEW.annotator_id:=normalize_text(NEW.annotator_id);
    select jsonb_array_length(scale->'levels') into k from gold_sets where id=s;
    if NEW.score<0 or NEW.score>=k then raise exception 'bad_request: annotation score off scale'; end if;
    if TG_TABLE_NAME='dev_annotations' and not exists(select 1 from items where set_id=s and item_key=NEW.item_key and split='dev') then raise exception 'forbidden: dev annotation split'; end if;
    if TG_TABLE_NAME='heldout_annotations' and not exists(select 1 from items where set_id=s and item_key=NEW.item_key and split='heldout') then raise exception 'forbidden: heldout annotation split'; end if;
  end if;
  if TG_OP<>'DELETE' and TG_TABLE_NAME='items' then
    if exists(select 1 from jsonb_array_elements(NEW.facts) f where jsonb_typeof(f)<>'string' or octet_length(f#>>'{}')>20480) then raise exception 'bad_request: invalid fact field'; end if;
    if TG_OP='INSERT' and (select count(*) from items where set_id=s)>=500 then raise exception 'bad_request: at most 500 items'; end if;
    NEW.item_key:=normalize_text(NEW.item_key); NEW.task_text:=normalize_text(NEW.task_text); NEW.answer:=normalize_text(NEW.answer); NEW.source:=normalize_text(NEW.source); NEW.group_key:=normalize_text(NEW.group_key); NEW.facts:=normalize_json(NEW.facts);
    NEW.fingerprint:=canonical_hash(jsonb_strip_nulls(jsonb_build_object('task',NEW.task_text,'answer',NEW.answer,'source',nullif(NEW.source,''),'facts',case when NEW.facts='[]'::jsonb then null else NEW.facts end)));
  end if;
  if TG_OP='DELETE' then return OLD; end if; return NEW;
end $$;
create trigger freeze_gold_sets before insert or update or delete on public.gold_sets for each row execute function public.frozen_guard();
do $$ declare t text; begin foreach t in array array['items','annotations_staging','dev_annotations','heldout_annotations','probe_pairs','injection_items'] loop execute format('create trigger freeze_inputs before insert or update or delete on public.%I for each row execute function public.frozen_guard()',t); end loop; end $$;
create trigger rubric_immutable before update or delete on public.rubric_versions for each row execute function public.append_only();
create trigger config_immutable before update or delete on public.judge_configs for each row execute function public.append_only();
create trigger verdicts_insert_only before update or delete on public.verdicts for each row execute function public.append_only();
create trigger jobs_immutable before update or delete on public.run_jobs for each row execute function public.append_only();

alter table public.gold_sets enable row level security;
alter table public.items enable row level security;
alter table public.annotations_staging enable row level security;
alter table public.dev_annotations enable row level security;
alter table public.heldout_annotations enable row level security;
alter table public.probe_pairs enable row level security;
alter table public.injection_items enable row level security;
alter table public.rubric_versions enable row level security;
alter table public.judge_configs enable row level security;
alter table public.runs enable row level security;
alter table public.run_jobs enable row level security;
alter table public.verdicts enable row level security;
create policy owner_read on public.gold_sets for select to authenticated using(owner_id=auth.uid() and (parent_set_id is null or owns_set(parent_set_id)));
create policy owner_insert on public.gold_sets for insert to authenticated with check(owner_id=auth.uid() and frozen_at is null and split_hash is null and (parent_set_id is null or owns_set(parent_set_id)));
create policy owner_read on public.items for select to authenticated using(owns_set(set_id));
create policy owner_insert on public.items for insert to authenticated with check(owns_set(set_id) and split is null and exists(select 1 from gold_sets where id=set_id and frozen_at is null));
create policy owner_insert on public.annotations_staging for insert to authenticated with check(owns_set(set_id) and exists(select 1 from gold_sets where id=set_id and frozen_at is null));
-- Staging annotations deliberately have no SELECT policy. freeze_input is limited to unfrozen input.
create policy owner_read on public.dev_annotations for select to authenticated using(owns_set(set_id) and exists(select 1 from items where items.set_id=dev_annotations.set_id and items.item_key=dev_annotations.item_key and split='dev'));
create policy owner_read on public.probe_pairs for select to authenticated using(owns_set(set_id));
create policy owner_read on public.injection_items for select to authenticated using(owns_set(set_id));
create policy owner_read on public.rubric_versions for select to authenticated using(owns_set(set_id));
create policy owner_read on public.judge_configs for select to authenticated using(owner_id=auth.uid());
create policy owner_read on public.runs for select to authenticated using(owner_id=auth.uid() and owns_set(set_id) and exists(select 1 from rubric_versions r where r.id=rubric_id and r.set_id=runs.set_id) and exists(select 1 from judge_configs j where j.id=judge_config_id and j.owner_id=auth.uid()));
-- Verdicts and run_jobs use guarded RPC reads, especially for heldout runs.
revoke all on all tables in schema public from anon, authenticated;
grant select on public.gold_sets,public.items,public.dev_annotations,public.probe_pairs,public.injection_items,public.rubric_versions,public.judge_configs,public.runs to authenticated;
grant insert on public.gold_sets,public.items,public.annotations_staging to authenticated;

create function public.item_dto(i public.items) returns jsonb language sql immutable set search_path = public, pg_temp as $$ select jsonb_strip_nulls(jsonb_build_object('key',i.item_key,'taskText',i.task_text,'answer',i.answer,'source',i.source,'facts',case when i.facts='[]'::jsonb then null else i.facts end,'groupId',i.group_key)); $$;
create function public.rubric_dto(r public.rubric_versions) returns jsonb language sql immutable set search_path = public, pg_temp as $$ select jsonb_build_object('id',r.id,'setId',r.set_id,'parentId',r.parent_id,'version',r.version,'instructions',r.instructions,'levels',r.levels,'changeNote',r.change_note,'contentHash',r.content_hash); $$;
create function public.config_dto(j public.judge_configs) returns jsonb language sql immutable set search_path = public, pg_temp as $$ select jsonb_build_object('id',j.id,'provider',j.provider,'model',j.model,'params',j.params,'promptTemplateVersion',j.prompt_template_version,'outputSchemaVersion',j.output_schema_version,'scoreReadout',j.score_readout,'levelMapVersion',j.level_map_version,'configHash',j.config_hash); $$;
create function public.run_dto(r public.runs) returns jsonb language sql stable set search_path = public, pg_temp as $$ select jsonb_build_object('id',r.id,'setId',r.set_id,'rubricId',r.rubric_id,'rubricHash',b.content_hash,'judgeConfigId',r.judge_config_id,'judgeConfigHash',j.config_hash,'split',r.split,'kind',r.kind,'status',r.status,'plan',r.plan,'plannedCalls',r.planned_calls,'completedCalls',r.completed_calls,'scoreItems',r.score_items,'completedScoreItems',r.completed_score_items,'resultHash',r.result_hash,'includeProbes',r.include_probes,'createdAt',r.created_at,'completedAt',r.completed_at,'preregId',r.prereg_id,'lookSeq',null,'error',r.error) from rubric_versions b,judge_configs j where b.id=r.rubric_id and j.id=r.judge_config_id; $$;
create function public.set_dto(s public.gold_sets) returns jsonb language sql stable set search_path = public, pg_temp as $$
 select jsonb_strip_nulls(jsonb_build_object('id',s.id,'name',s.name,'scale',s.scale,'contentHash',s.content_hash,'annotationHash',s.annotation_hash,'parentSetId',s.parent_set_id,'frozen',s.frozen_at is not null,'importReport',s.import_report,'inheritedContamination',s.inherited_contamination,'split',s.split_manifest,
 'items',coalesce((select jsonb_agg(item_dto(i) order by utf16_key(i.item_key)) from items i where i.set_id=s.id),'[]'),
 'devAnnotations',coalesce((select jsonb_agg(jsonb_build_object('itemKey',item_key,'annotatorId',annotator_id,'score',score) order by utf16_key(item_key),utf16_key(annotator_id)) from dev_annotations where set_id=s.id),'[]'),
 'probeSets',jsonb_build_object('pairs',coalesce((select jsonb_agg(payload order by id) from probe_pairs where set_id=s.id and not rejected),'[]'),'rejectedPairs',coalesce((select jsonb_agg(payload order by id) from probe_pairs where set_id=s.id and rejected),'[]'),'injections',coalesce((select jsonb_agg(payload order by id) from injection_items where set_id=s.id),'[]'))));
$$;
create function public.verdict_rows(rid text, primary_only boolean default true) returns jsonb language sql stable set search_path = public, pg_temp as $$
 select coalesce(jsonb_agg(jsonb_build_object('runId',v.run_id,'itemKey',j.item_key,'replicate',j.replicate,'score',v.score,'unusableReason',v.unusable_reason,'raw',v.raw) order by utf16_key(j.item_key),j.replicate),'[]') from verdicts v join run_jobs j on j.run_id=v.run_id and j.id=v.item_key and j.ledger_replicate=v.replicate where v.run_id=rid and (not primary_only or j.kind='score');
$$;
create function public.job_verdict_rows(rid text) returns jsonb language sql stable set search_path = public, pg_temp as $$
 select coalesce(jsonb_agg(jsonb_build_object('jobId',v.item_key,'score',v.score,'unusableReason',v.unusable_reason,'raw',v.raw) order by utf16_key(v.item_key),v.replicate),'[]') from verdicts v where v.run_id=rid;
$$;
create function public.content_resplit_guard(oid uuid, h text) returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare denied boolean; contaminated boolean;
begin
  perform pg_advisory_xact_lock(hashtextextended(oid::text||':'||h,36));
  if to_regclass('public.heldout_scopes') is null then return false; end if;
  execute 'select exists(select 1 from heldout_scopes s where owner_id=$1 and content_hash=$2 and exists(select 1 from heldout_log l where l.scope_id=s.id and l.kind=''look'') and not exists(select 1 from heldout_log l where l.scope_id=s.id and l.kind=''burn'')), exists(select 1 from heldout_scopes s join heldout_log l on l.scope_id=s.id and l.kind=''look'' where s.owner_id=$1 and s.content_hash=$2)' into denied,contaminated using oid,h;
  if denied then raise exception 'resplit_refused: burn every looked scope for this content first'; end if; return contaminated;
end $$;

create function public.import_set(p_args jsonb) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare oid uuid:=owner_uid(); st jsonb:=normalize_json(p_args->'staged'); s gold_sets; x jsonb; fp text; h text; ah text; par text:=p_args->>'parentSetId'; inherited boolean:=false; parent_burned boolean:=false;
begin
  if st is null or octet_length(p_args::text)>26214400 or not valid_scale(st->'scale') or jsonb_array_length(st->'items') not between 1 and 500 or coalesce((st->'report'->>'ok')::boolean,false)=false then raise exception 'bad_request: invalid staged import'; end if;
  if par is not null and not exists(select 1 from gold_sets where id=par and owner_id=oid) then raise exception 'forbidden: parent set ownership'; end if;
  if par is not null then
    select inherited_contamination into inherited from gold_sets where id=par;
    if to_regclass('public.heldout_scopes') is not null then execute 'select exists(select 1 from heldout_scopes hs join heldout_log l on l.scope_id=hs.id and l.kind=''burn'' join gold_sets g on g.id=$1 and g.content_hash=hs.content_hash where hs.owner_id=$2)' into parent_burned using par,oid; end if;
  end if;
  insert into gold_sets(owner_id,name,scale,split_seed,heldout_fraction,content_hash,annotation_hash,parent_set_id,import_report,inherited_contamination)
  values(oid,st->>'name',st->'scale',(st->>'splitSeed')::bigint,(st->>'heldoutFraction')::numeric,st->>'contentHash',st->>'annotationHash',par,st->'report',coalesce(inherited,false) or parent_burned) returning * into s;
  for x in select value from jsonb_array_elements(st->'items') loop
    fp:=canonical_hash(jsonb_strip_nulls(jsonb_build_object('task',x->>'taskText','answer',x->>'answer','source',nullif(x->>'source',''),'facts',case when coalesce(x->'facts','[]')='[]'::jsonb then null else x->'facts' end)));
    insert into items(set_id,item_key,fingerprint,group_key,task_text,answer,source,facts) values(s.id,x->>'key',fp,x->>'groupId',x->>'taskText',x->>'answer',x->>'source',coalesce(x->'facts','[]'));
  end loop;
  for x in select value from jsonb_array_elements(st->'stagedAnnotations') loop
    if (x->>'score')::numeric<>trunc((x->>'score')::numeric) then raise exception 'bad_request: annotation must be an integer'; end if;
    insert into annotations_staging values(s.id,x->>'itemKey',x->>'annotatorId',(x->>'score')::integer);
  end loop;
  if exists(select 1 from items i where i.set_id=s.id and (select count(*) from annotations_staging a where a.set_id=s.id and a.item_key=i.item_key)<2) then raise exception 'bad_request: two distinct annotators per item required'; end if;
  select canonical_hash(jsonb_agg(fingerprint order by utf16_key(fingerprint))) into h from items where set_id=s.id;
  select canonical_hash(jsonb_agg(t order by utf16_key(canonical_json(t)))) into ah from (select jsonb_build_array(i.fingerprint,a.annotator_id,a.score) t from annotations_staging a join items i using(set_id,item_key) where a.set_id=s.id) z;
  if h<>s.content_hash or ah<>s.annotation_hash then raise exception 'prereg_mismatch: import content or annotation hash mismatch'; end if;
  return jsonb_build_object('set',set_dto(s),'report',s.import_report);
end $$;
create function public.freeze_input(p_args jsonb) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare s gold_sets; oid uuid:=owner_uid();
begin
 select * into s from gold_sets where id=p_args->>'setId' and owner_id=oid; if not found then raise exception 'not_found: set'; end if;
 if s.frozen_at is not null then raise exception 'frozen: staging unavailable after freeze'; end if;
 return jsonb_build_object('items',(select jsonb_agg(item_dto(i) order by utf16_key(item_key)) from items i where set_id=s.id),'annotations',(select jsonb_agg(jsonb_build_object('itemKey',item_key,'annotatorId',annotator_id,'score',score)) from annotations_staging where set_id=s.id),'seed',s.split_seed,'heldoutFraction',s.heldout_fraction);
end $$;
create function public.freeze_set(p_args jsonb) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare s gold_sets; oid uuid:=owner_uid(); keys text[]; n integer; nh integer; sh text; ch text; ah text; inherited boolean; parent_inherited boolean:=false; parent_burned boolean:=false; manifest jsonb; achieved jsonb; seed bigint; fraction numeric;
begin
 select * into s from gold_sets where id=p_args->>'setId' and owner_id=oid for update; if not found then raise exception 'not_found: set'; end if;
 if s.frozen_at is not null then raise exception 'frozen: already frozen'; end if;
 seed:=(p_args->>'seed')::bigint; fraction:=coalesce((p_args->>'heldoutFraction')::numeric,s.heldout_fraction);
 if seed is null or seed not between 0 and 4294967295 or fraction<=0 or fraction>=1 then raise exception 'bad_request: split parameters'; end if;
 select array_agg(value) into keys from jsonb_array_elements_text(p_args->'heldoutItemKeys');
 select count(*) into n from items where set_id=s.id; nh:=coalesce(cardinality(keys),0);
 if n-nh<20 or nh<20 or nh<>(select count(distinct x) from unnest(keys) x) or exists(select 1 from unnest(keys) x where not exists(select 1 from items where set_id=s.id and item_key=x)) then raise exception 'bad_request: split floor or unknown/duplicate keys'; end if;
 if exists(select 1 from items a join items b on a.set_id=b.set_id and (a.fingerprint=b.fingerprint or a.group_key=b.group_key and a.group_key is not null) where a.set_id=s.id and (a.item_key=any(keys))<>(b.item_key=any(keys))) then raise exception 'bad_request: group crosses split'; end if;
 -- Connected components implement explicit-group UNION duplicate-fingerprint membership.
 if exists(with recursive edges as (select a.item_key a,b.item_key b from items a join items b on a.set_id=b.set_id and (a.fingerprint=b.fingerprint or a.group_key=b.group_key and a.group_key is not null) where a.set_id=s.id), reach(a,b) as (select a,b from edges union select r.a,e.b from reach r join edges e on e.a=r.b), components as (select a,min(b collate "C") g from reach group by a) select 1 from components group by g having count(*)>floor(n*fraction+0.5)) then raise exception 'bad_request: largest group exceeds heldout target'; end if;
 if exists(select 1 from items i where set_id=s.id and (select count(*) from annotations_staging a where a.set_id=s.id and a.item_key=i.item_key)<2) then raise exception 'bad_request: missing annotations'; end if;
 select canonical_hash(jsonb_agg(fingerprint order by utf16_key(fingerprint))) into ch from items where set_id=s.id;
 select canonical_hash(jsonb_agg(t order by utf16_key(canonical_json(t)))) into ah from (select jsonb_build_array(i.fingerprint,a.annotator_id,a.score) t from annotations_staging a join items i using(set_id,item_key) where a.set_id=s.id) z;
 if ch is distinct from s.content_hash or ah is distinct from s.annotation_hash then raise exception 'prereg_mismatch: staged content/annotation integrity'; end if;
 if exists(select 1 from (select payload from probe_pairs where set_id=s.id and not rejected union all select payload from injection_items where set_id=s.id) p where payload ? 'baseItemId' and (not exists(select 1 from items where set_id=s.id and item_key=payload->>'baseItemId') or payload->>'baseItemId'=any(keys))) then raise exception 'bad_request: probe base unknown or heldout'; end if;
 select canonical_hash(jsonb_build_object('algoVersion',s.split_algo_version,'heldout',jsonb_agg(fingerprint order by utf16_key(fingerprint)),'seed',seed)) into sh from items where set_id=s.id and item_key=any(keys);
 if sh is distinct from p_args->>'splitHash' then raise exception 'prereg_mismatch: split hash'; end if;
 inherited:=content_resplit_guard(oid,s.content_hash) or s.inherited_contamination;
 if s.parent_set_id is not null then
   select inherited_contamination into parent_inherited from gold_sets where id=s.parent_set_id and owner_id=oid;
   if to_regclass('public.heldout_scopes') is not null then execute 'select exists(select 1 from heldout_scopes hs join heldout_log l on l.scope_id=hs.id and l.kind=''burn'' join gold_sets g on g.id=$1 and g.content_hash=hs.content_hash where hs.owner_id=$2)' into parent_burned using s.parent_set_id,oid; end if;
   inherited:=inherited or coalesce(parent_inherited,false) or parent_burned;
 end if;
 with recursive edges as (select a.item_key a,b.item_key b from items a join items b on a.set_id=b.set_id and (a.fingerprint=b.fingerprint or a.group_key=b.group_key and a.group_key is not null) where a.set_id=s.id),
 reach(a,b) as (select a,b from edges union select r.a,e.b from reach r join edges e on e.a=r.b),
 components as(select a,min(b collate "C") g from reach group by a),
 means as(select item_key,avg(score::numeric) mean_score from annotations_staging where set_id=s.id group by item_key),
 strata as(select c.g,floor(avg(m.mean_score)+0.5)::integer stratum from components c join means m on m.item_key=c.a group by c.g),
 counts as(select case when c.a=any(keys) then 'heldout' else 'dev' end side,st.stratum,count(*) n from components c join strata st on st.g=c.g group by side,st.stratum)
 select jsonb_build_object('dev',jsonb_build_object('total',n-nh,'byStratum',coalesce((select jsonb_agg(jsonb_build_object('stratum',stratum,'count',counts.n) order by stratum) from counts where side='dev'),'[]')),'heldout',jsonb_build_object('total',nh,'byStratum',coalesce((select jsonb_agg(jsonb_build_object('stratum',stratum,'count',counts.n) order by stratum) from counts where side='heldout'),'[]'))) into achieved;
 update items set split=case when item_key=any(keys) then 'heldout' else 'dev' end where set_id=s.id;
 insert into dev_annotations select a.* from annotations_staging a join items i using(set_id,item_key) where a.set_id=s.id and i.split='dev';
 insert into heldout_annotations select a.* from annotations_staging a join items i using(set_id,item_key) where a.set_id=s.id and i.split='heldout';
 delete from annotations_staging where set_id=s.id;
 manifest:=jsonb_build_object('seed',seed,'heldoutFraction',fraction,'algoVersion',s.split_algo_version,'splitHash',sh,'frozenAt',clock_timestamp(),'achieved',achieved,'heldout',(select jsonb_agg(item_key order by utf16_key(item_key)) from items where set_id=s.id and split='heldout'),'dev',(select jsonb_agg(item_key order by utf16_key(item_key)) from items where set_id=s.id and split='dev'));
 update gold_sets set split_seed=seed,heldout_fraction=fraction,split_hash=sh,split_manifest=manifest,frozen_at=clock_timestamp(),inherited_contamination=inherited where id=s.id returning * into s;
 return set_dto(s);
end $$;

create function public.import_probe_sets(p_args jsonb) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare s gold_sets; x jsonb; oid uuid:=owner_uid(); p jsonb:=normalize_json(p_args->'probeSets');
begin
 select * into s from gold_sets where id=p_args->>'setId' and owner_id=oid for update; if not found then raise exception 'not_found: set'; end if;
 if s.frozen_at is not null then raise exception 'frozen: import probes before freeze'; end if;
 if octet_length(p_args::text)>26214400 or not coalesce((p_args->'report'->>'ok')::boolean,false) then raise exception 'bad_request: invalid probe import'; end if;
 for x in select value from jsonb_array_elements(coalesce(p->'pairs','[]')) union all select value from jsonb_array_elements(coalesce(p->'rejectedPairs','[]')) loop
   if octet_length(x->>'taskText')>20480 or octet_length(x->>'shortText')>20480 or octet_length(x->>'longText')>20480 then raise exception 'bad_request: oversize probe'; end if;
   insert into probe_pairs values(s.id,x->>'id',x,not exists(select 1 from jsonb_array_elements(coalesce(p->'pairs','[]')) y where y->>'id'=x->>'id'));
 end loop;
 for x in select value from jsonb_array_elements(coalesce(p->'injections','[]')) loop
   if octet_length(x->>'taskText')>20480 or octet_length(x->>'baseAnswer')>20480 or octet_length(x->>'answer')>20480 then raise exception 'bad_request: oversize injection'; end if;
   insert into injection_items values(s.id,x->>'id',x);
 end loop;
 return p_args->'report';
end $$;
create function public.create_rubric(p_args jsonb) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare oid uuid:=owner_uid(); s gold_sets; x jsonb:=normalize_json(p_args->'rubric'); r rubric_versions; parent rubric_versions; h text;
begin
 select * into s from gold_sets where id=p_args->>'setId' and owner_id=oid; if not found then raise exception 'not_found: set'; end if;
 if x->>'setId' is distinct from s.id or jsonb_array_length(x->'levels')<>jsonb_array_length(s.scale->'levels') then raise exception 'bad_request: rubric set/scale'; end if;
 if exists(select 1 from jsonb_array_elements(x->'levels') with ordinality l(v,n) join jsonb_array_elements(s.scale->'levels') with ordinality k(v,n) using(n) where l.v->'value' is distinct from k.v->'value' or jsonb_typeof(l.v->'description') is distinct from 'string' or octet_length(l.v->>'description')>20480) then raise exception 'bad_request: rubric levels'; end if;
 if x->>'parentId' is not null then
   select * into parent from rubric_versions where id=x->>'parentId' and set_id=s.id; if not found or (x->>'version')::integer<>parent.version+1 or length(trim(coalesce(x->>'changeNote','')))=0 then raise exception 'bad_request: rubric parent/version/note'; end if;
 elsif (x->>'version')::integer<>1 then raise exception 'bad_request: root rubric version'; end if;
 h:=canonical_hash(jsonb_build_object('instructions',x->>'instructions','levels',x->'levels'));
 if h is distinct from x->>'contentHash' then raise exception 'prereg_mismatch: rubric hash'; end if;
 select * into r from rubric_versions where set_id=s.id and content_hash=h; if found then return rubric_dto(r); end if;
 insert into rubric_versions(id,set_id,parent_id,version,instructions,levels,change_note,content_hash) values(coalesce(x->>'id',gen_random_uuid()::text),s.id,x->>'parentId',(x->>'version')::integer,x->>'instructions',x->'levels',coalesce(x->>'changeNote',''),h) returning * into r;
 return rubric_dto(r);
end $$;
create function public.create_judge_config(p_args jsonb) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare oid uuid:=owner_uid(); x jsonb:=normalize_json(p_args->'config'); h text; j judge_configs;
begin
 h:=canonical_hash(x); if h is distinct from p_args->>'configHash' then raise exception 'prereg_mismatch: config hash'; end if;
 select * into j from judge_configs where owner_id=oid and config_hash=h; if found then return config_dto(j); end if;
 insert into judge_configs(owner_id,provider,model,params,prompt_template_version,output_schema_version,score_readout,level_map_version,config_hash) values(oid,x->>'provider',x->>'model',x->'params',x->>'promptTemplateVersion',x->>'outputSchemaVersion',x->>'scoreReadout',x->>'levelMapVersion',h) returning * into j;
 return config_dto(j);
end $$;
create function public.create_dev_run(p_args jsonb) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare oid uuid:=owner_uid(); s gold_sets; j judge_configs; r runs; n integer; probes boolean:=coalesce((p_args->>'includeProbes')::boolean,false);
begin
 select * into s from gold_sets where id=p_args->>'setId' and owner_id=oid for update; if not found then raise exception 'not_found: set'; end if;
 if s.frozen_at is null then raise exception 'prerequisite_missing: freeze first'; end if;
 perform 1 from rubric_versions where id=p_args->>'rubricId' and set_id=s.id; if not found then raise exception 'forbidden: rubric set'; end if;
 select * into j from judge_configs where id=p_args->>'judgeConfigId' and owner_id=oid; if not found then raise exception 'forbidden: judge config'; end if;
 if j.provider<>'mock' and not coalesce((p_args->>'confirmed')::boolean,false) then raise exception 'bad_request: explicit live confirmation required'; end if;
 if probes and exists(select 1 from (select payload from probe_pairs where set_id=s.id and not rejected union all select payload from injection_items where set_id=s.id) p where payload ? 'baseItemId' and not exists(select 1 from items where set_id=s.id and item_key=payload->>'baseItemId' and split='dev')) then raise exception 'bad_request: probe base must be dev'; end if;
 select count(*) into n from items where set_id=s.id and split='dev'; if n<20 then raise exception 'prerequisite_missing: dev floor'; end if;
 insert into runs(owner_id,set_id,rubric_id,judge_config_id,split,planned_calls,score_items,include_probes,plan) values(oid,s.id,p_args->>'rubricId',j.id,'dev',n,n,probes,coalesce(p_args->'plan','{}')) returning * into r;
 return run_dto(r);
end $$;
create function public.dev_run_rows(p_args jsonb) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare oid uuid:=owner_uid(); r runs;
begin
 select * into r from runs where id=p_args->>'runId' and owner_id=oid and split='dev'; if not found then raise exception 'forbidden: owned dev run required'; end if;
 return jsonb_build_object('set',(select set_dto(s) from gold_sets s where s.id=r.set_id),'run',run_dto(r),'rubric',(select rubric_dto(b) from rubric_versions b where b.id=r.rubric_id),'config',(select config_dto(j) from judge_configs j where j.id=r.judge_config_id),'verdicts',verdict_rows(r.id),'jobs',coalesce((select jsonb_agg(payload order by utf16_key(id),ledger_replicate) from run_jobs where run_id=r.id),'[]'),'jobVerdicts',job_verdict_rows(r.id));
end $$;

-- Every function is private by default; later migrations grant only named entrypoints.
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.owns_set(text),public.valid_scale(jsonb) to authenticated;
grant execute on function public.import_set(jsonb),public.freeze_input(jsonb),public.freeze_set(jsonb),public.import_probe_sets(jsonb),public.create_rubric(jsonb),public.create_judge_config(jsonb),public.create_dev_run(jsonb),public.dev_run_rows(jsonb) to authenticated;
