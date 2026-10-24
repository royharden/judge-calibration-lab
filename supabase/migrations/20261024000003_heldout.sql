-- Heldout authorization spends slots before execution, under one scope/content lock.
create table public.heldout_scopes (
 id text primary key, owner_id uuid not null references auth.users(id), content_hash text not null, judge_config_hash text not null, created_at timestamptz not null default clock_timestamp(),
 unique(owner_id,content_hash,judge_config_hash)
);
create table public.preregistrations (
 id text primary key default gen_random_uuid()::text, scope_id text not null references public.heldout_scopes(id), owner_id uuid not null references auth.users(id), set_id text not null references public.gold_sets(id),
 judge_config_id text not null references public.judge_configs(id), baseline_rubric_id text not null references public.rubric_versions(id), chosen_rubric_id text not null references public.rubric_versions(id),
 baseline_dev_run_id text not null references public.runs(id), pins jsonb not null, request_id text not null, created_at timestamptz not null default clock_timestamp(), unique(owner_id,request_id)
);
create table public.heldout_log (
 id uuid primary key default gen_random_uuid(), seq bigint generated always as identity unique, scope_id text not null references public.heldout_scopes(id),
 kind text not null check(kind in ('look','burn')), rubric_hash text, prereg_id text references public.preregistrations(id), run_id text references public.runs(id) deferrable initially deferred,
 reason text, at timestamptz not null default clock_timestamp(),
 check((kind='look' and rubric_hash is not null and prereg_id is not null and run_id is not null and reason is null) or (kind='burn' and rubric_hash is null and prereg_id is null and run_id is null and length(trim(reason))>0))
);
create unique index one_look_per_hash on public.heldout_log(scope_id,rubric_hash) where kind='look';
create unique index one_burn_per_scope on public.heldout_log(scope_id) where kind='burn';
alter table public.runs add constraint runs_heldout_look_fk foreign key(heldout_look_id) references public.heldout_log(id);
alter table public.runs add constraint runs_prereg_fk foreign key(prereg_id) references public.preregistrations(id);
alter table public.heldout_scopes enable row level security;
alter table public.preregistrations enable row level security;
alter table public.heldout_log enable row level security;
create trigger preregistrations_insert_only before update or delete on public.preregistrations for each row execute function public.append_only();
create trigger heldout_log_insert_only before update or delete on public.heldout_log for each row execute function public.append_only();
create trigger scopes_immutable before update or delete on public.heldout_scopes for each row execute function public.append_only();
create policy owner_read on public.heldout_scopes for select to authenticated using(owner_id=auth.uid());
create policy owner_read on public.preregistrations for select to authenticated using(owner_id=auth.uid() and owns_set(set_id) and exists(select 1 from heldout_scopes s where s.id=scope_id and s.owner_id=auth.uid()));
create policy owner_read on public.heldout_log for select to authenticated using(exists(select 1 from heldout_scopes s where s.id=scope_id and s.owner_id=auth.uid()));
revoke all on public.heldout_scopes,public.preregistrations,public.heldout_log from public,anon,authenticated;
grant select on public.heldout_scopes,public.preregistrations,public.heldout_log to authenticated;

create function public.standard_policy() returns jsonb language sql immutable set search_path = public, pg_temp as $$
 select '{"version":"s36-v1","primaryMetric":"mean_judge_annotator_qwk","verdictRule":"paired_ci95_lo_gt_0_improved__hi_lt_0_worse__else_no_detectable_change","confidence":0.95,"nFloor":20,"overlapFloor":10,"missingness":{"rule":"T=max(2,floor(0.05*N))","tMin":2,"tFraction":0.05},"bootstrap":{"method":"paired_percentile_group","seed":36,"resamples":2000,"quantile":"type7","streamLabel":"bootstrap","maxUndefinedShare":0.1},"band":0.25,"jevMargin":0.05,"maxDistinctLooks":2,"algorithmVersions":{"split":"stratified-group-greedy/v1","prng":"xoshiro128starstar+splitmix32/v1","quantile":"hyndman-fan-type7/v1","pav":"weighted-pav-halfdown-fill-lower/v1","tokenizer":"nfc-lower-strip-punct-ws/v1","bootstrap":"percentile-group-bootstrap/v1","canonical":"nfc-lf-trimeol+sortedjson/v1"}}'::jsonb;
$$;
create function public.prereg_dto(p public.preregistrations) returns jsonb language sql immutable set search_path = public, pg_temp as $$ select jsonb_build_object('id',p.id,'scopeKey',p.scope_id,'pins',p.pins,'createdAt',p.created_at); $$;
create or replace function public.run_dto(r public.runs) returns jsonb language sql stable set search_path = public, pg_temp as $$
 select jsonb_build_object('id',r.id,'setId',r.set_id,'rubricId',r.rubric_id,'rubricHash',b.content_hash,'judgeConfigId',r.judge_config_id,'judgeConfigHash',j.config_hash,'split',r.split,'kind',r.kind,'status',r.status,'plan',r.plan,'plannedCalls',r.planned_calls,'completedCalls',r.completed_calls,'scoreItems',r.score_items,'completedScoreItems',r.completed_score_items,'resultHash',r.result_hash,'includeProbes',r.include_probes,'createdAt',r.created_at,'completedAt',r.completed_at,'preregId',r.prereg_id,'lookSeq',(select l.seq from heldout_log l where l.id=r.heldout_look_id),'error',r.error) from rubric_versions b,judge_configs j where b.id=r.rubric_id and j.id=r.judge_config_id;
$$;
create function public.scope_dto(s public.heldout_scopes, inherited boolean default false) returns jsonb language sql stable set search_path = public, pg_temp as $$
 with status as(select exists(select 1 from heldout_log where scope_id=s.id and kind='burn') burned,coalesce((select jsonb_agg(rubric_hash order by utf16_key(rubric_hash)) from heldout_log where scope_id=s.id and kind='look'),'[]') hashes)
 select jsonb_build_object('scopeKey',s.id,'status',case when burned or inherited then 'contaminated' else 'clean' end,'burned',burned,'distinctLookedHashes',hashes,'looksUsed',jsonb_array_length(hashes),'slotsRemaining',case when burned then null else greatest(0,2-jsonb_array_length(hashes)) end,'maxDistinctLooks',2) from status;
$$;
create view public.contamination_status with (security_invoker=true) as
 select s.id as scope_id,s.owner_id,s.content_hash,s.judge_config_hash,
 exists(select 1 from heldout_log where scope_id=s.id and kind='burn') as burned,
 (select count(*) from heldout_log where scope_id=s.id and kind='look') as looks_used,
 exists(select 1 from heldout_log where scope_id=s.id and kind='burn') or exists(select 1 from gold_sets g where g.owner_id=s.owner_id and g.content_hash=s.content_hash and g.inherited_contamination) as contaminated
 from heldout_scopes s;
revoke all on public.contamination_status from public,anon,authenticated;

create function public.check_prereg_pins(p public.preregistrations) returns void language plpgsql set search_path = public, pg_temp as $$
declare s gold_sets; b rubric_versions; c rubric_versions; j judge_configs; pol jsonb:=standard_policy(); sh text; ah text; ch text; actual_pins jsonb;
begin
 select * into s from gold_sets where id=p.set_id and owner_id=p.owner_id;
 select * into b from rubric_versions where id=p.baseline_rubric_id and set_id=p.set_id;
 select * into c from rubric_versions where id=p.chosen_rubric_id and set_id=p.set_id;
 select * into j from judge_configs where id=p.judge_config_id and owner_id=p.owner_id;
 if s.id is null or b.id is null or c.id is null or j.id is null or s.frozen_at is null then raise exception 'prereg_mismatch: frozen records/ownership'; end if;
 select canonical_hash(jsonb_build_object('algoVersion',s.split_algo_version,'heldout',jsonb_agg(fingerprint order by utf16_key(fingerprint)),'seed',s.split_seed)) into sh from items where set_id=s.id and split='heldout';
 select canonical_hash(jsonb_agg(t order by utf16_key(canonical_json(t)))) into ah from (select jsonb_build_array(i.fingerprint,a.annotator_id,a.score) t from (select * from dev_annotations union all select * from heldout_annotations) a join items i using(set_id,item_key) where a.set_id=s.id) z;
 select canonical_hash(jsonb_agg(fingerprint order by utf16_key(fingerprint))) into ch from items where set_id=s.id;
 actual_pins:=jsonb_build_object('owner',p.owner_id,'setId',s.id,'contentHash',ch,'splitHash',sh,'annotationHash',ah,'scaleHash',canonical_hash(s.scale),'baselineRubricHash',b.content_hash,'chosenRubricHash',c.content_hash,'judgeConfigHash',j.config_hash,'policyVersion','s36-v1','policyHash',canonical_hash(pol),'algorithmVersions',pol->'algorithmVersions','bootstrap',jsonb_build_object('seed',36,'resamples',2000),'baselineDevRunId',p.baseline_dev_run_id);
 if ch<>s.content_hash or ah<>s.annotation_hash or sh<>s.split_hash or not p.pins @> actual_pins or p.pins-'fitHashes' is distinct from actual_pins then raise exception 'prereg_mismatch: stored pins/hash/policy differ'; end if;
 if nullif(p.pins->'fitHashes'->>'lexicalCutPoints','') is null or nullif(p.pins->'fitHashes'->>'modalLevel','') is null or nullif(p.pins->'fitHashes'->>'pavMap','') is null or (select count(*) from jsonb_object_keys(p.pins->'fitHashes'))<>3 then raise exception 'prerequisite_missing: all three server-computed fit hashes required'; end if;
 if not exists(select 1 from runs r where r.id=p.baseline_dev_run_id and r.owner_id=p.owner_id and r.set_id=s.id and r.rubric_id=b.id and r.judge_config_id=j.id and r.split='dev' and r.kind='score' and r.status='complete' and r.result_hash is not null and r.result_hash=canonical_hash(verdict_rows(r.id))) then raise exception 'prerequisite_missing: completed baseline dev score evidence'; end if;
 if b.content_hash=c.content_hash then raise exception 'bad_request: baseline and chosen must differ'; end if;
 if not exists(select 1 from heldout_scopes h where h.id=p.scope_id and h.owner_id=p.owner_id and h.content_hash=s.content_hash and h.judge_config_hash=j.config_hash) then raise exception 'prereg_mismatch: scope identity'; end if;
end $$;
create function public.preregister(p_args jsonb) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare oid uuid:=(p_args->>'owner')::uuid; s gold_sets; j judge_configs; scope_key text; p preregistrations; existing preregistrations;
begin
 perform require_service();
 select * into s from gold_sets where id=p_args->>'setId' and owner_id=oid for share; if not found then raise exception 'forbidden: owned set required'; end if;
 select * into j from judge_configs where id=p_args->>'judgeConfigId' and owner_id=oid; if not found then raise exception 'forbidden: owned config required'; end if;
 perform pg_advisory_xact_lock(hashtextextended(oid::text||':'||s.content_hash,36));
 scope_key:=canonical_hash(jsonb_build_object('owner',oid,'contentHash',s.content_hash,'judgeConfigHash',j.config_hash));
 insert into heldout_scopes(id,owner_id,content_hash,judge_config_hash) values(scope_key,oid,s.content_hash,j.config_hash) on conflict do nothing;
 p.id:=gen_random_uuid()::text; p.scope_id:=scope_key; p.owner_id:=oid; p.set_id:=s.id; p.judge_config_id:=j.id;
 p.baseline_rubric_id:=p_args->>'baselineRubricId'; p.chosen_rubric_id:=p_args->>'chosenRubricId'; p.baseline_dev_run_id:=p_args->>'baselineDevRunId'; p.pins:=p_args->'pins'; p.request_id:=p_args->>'requestId'; p.created_at:=clock_timestamp();
 perform check_prereg_pins(p);
 select * into existing from preregistrations where owner_id=oid and request_id=p.request_id;
 if found then if existing.pins is distinct from p.pins then raise exception 'bad_request: preregistration request reused'; end if; return prereg_dto(existing); end if;
 insert into preregistrations select (p).*; return prereg_dto(p);
end $$;
create function public.request_heldout_look(p_args jsonb) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare oid uuid:=owner_uid(); p preregistrations; sc heldout_scopes; s gold_sets; j judge_configs; burned boolean; looked integer; needed integer; looks jsonb:='[]'; role_name text; h text; rb text; entry heldout_log; r runs; rid text; n integer; was_reused boolean;
begin
 select * into p from preregistrations where id=p_args->>'preregId' and owner_id=oid; if not found then raise exception 'forbidden: owned preregistration required'; end if;
 select * into s from gold_sets where id=p.set_id;
 perform pg_advisory_xact_lock(hashtextextended(oid::text||':'||s.content_hash,36));
 select * into sc from heldout_scopes where id=p.scope_id and owner_id=oid for update;
 if not found then raise exception 'forbidden: scope ownership'; end if;
 perform check_prereg_pins(p);
 select * into j from judge_configs where id=p.judge_config_id;
 if j.provider<>'mock' and not coalesce((p_args->>'confirmed')::boolean,false) then raise exception 'bad_request: explicit heldout confirmation required'; end if;
 -- Sets may have been frozen concurrently before their first look. Re-check across EVERY
 -- judge-config scope now, so an already frozen sibling cannot bypass the re-split lock.
 if exists(select 1 from heldout_scopes hs join heldout_log l on l.scope_id=hs.id and l.kind='look' join runs lr on lr.id=l.run_id join gold_sets gs on gs.id=lr.set_id where hs.owner_id=oid and hs.content_hash=s.content_hash and gs.split_hash<>s.split_hash and not exists(select 1 from heldout_log burn where burn.scope_id=hs.id and burn.kind='burn')) then raise exception 'resplit_refused: another unburned scope already looked a different split'; end if;
 burned:=exists(select 1 from heldout_log where scope_id=sc.id and kind='burn');
 select count(*) into looked from heldout_log where scope_id=sc.id and kind='look';
 select count(*) into needed from (select distinct wanted_hash.value from unnest(array[p.pins->>'baselineRubricHash',p.pins->>'chosenRubricHash']) as wanted_hash(value) where not exists(select 1 from heldout_log where scope_id=sc.id and rubric_hash=wanted_hash.value and kind='look')) wanted;
 if not burned and looked+needed>2 then raise exception 'heldout_exhausted: two distinct looked rubric hashes maximum'; end if;
 select count(*) into n from items where set_id=s.id and split='heldout'; if n<20 then raise exception 'prerequisite_missing: heldout floor'; end if;
 foreach role_name in array array['baseline','chosen'] loop
   h:=p.pins->>(role_name||'RubricHash'); rb:=case when role_name='baseline' then p.baseline_rubric_id else p.chosen_rubric_id end;
   select * into entry from heldout_log where scope_id=sc.id and rubric_hash=h and kind='look'; was_reused:=found;
   if not was_reused then
     rid:=gen_random_uuid()::text;
     insert into heldout_log(scope_id,kind,rubric_hash,prereg_id,run_id) values(sc.id,'look',h,p.id,rid) returning * into entry;
     insert into runs(id,owner_id,set_id,rubric_id,judge_config_id,split,kind,heldout_look_id,prereg_id,planned_calls,score_items) values(rid,oid,s.id,rb,j.id,'heldout','score',entry.id,p.id,n,n);
   end if;
   looks:=looks||jsonb_build_array(jsonb_build_object('role',role_name,'rubricHash',h,'runId',entry.run_id,'lookSeq',entry.seq,'reused',was_reused));
 end loop;
 return jsonb_build_object('scopeKey',sc.id,'looks',looks,'newSlotsUsed',needed,'distinctLooked',looked+needed,'slotsRemaining',case when burned then null else greatest(0,2-looked-needed) end,'burned',burned);
end $$;
create function public.burn_scope(p_args jsonb) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare oid uuid:=owner_uid(); s heldout_scopes; why text:=trim(coalesce(p_args->>'reason',''));
begin
 select * into s from heldout_scopes where id=p_args->>'scopeKey' and owner_id=oid;
 if not found then raise exception 'forbidden: scope owner required'; end if;
 perform pg_advisory_xact_lock(hashtextextended(oid::text||':'||s.content_hash,36));
 select * into s from heldout_scopes where id=s.id for update;
 if why='' then raise exception 'bad_request: burn requires reason'; end if;
 if p_args->>'confirmation' is distinct from 'burn '||left(s.id,8) then raise exception 'confirmation_mismatch: type burn plus first eight scope characters'; end if;
 if exists(select 1 from heldout_log where scope_id=s.id and kind='burn') then raise exception 'already_burned: permanent burn already recorded'; end if;
 insert into heldout_log(scope_id,kind,reason) values(s.id,'burn',why); return scope_dto(s);
end $$;
create function public.scope_status(p_args jsonb) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare oid uuid:=owner_uid(); sc heldout_scopes; inherited boolean:=false;
begin
 select * into sc from heldout_scopes where id=p_args->>'scopeKey' and owner_id=oid;
 if p_args->>'setId' is not null then
   select inherited_contamination into inherited from gold_sets where id=p_args->>'setId' and owner_id=oid and (sc.id is null or content_hash=sc.content_hash);
   if not found then raise exception 'forbidden: set scope ownership'; end if;
 end if;
 if sc.id is null then return jsonb_build_object('scopeKey',p_args->>'scopeKey','status',case when inherited then 'contaminated' else 'clean' end,'burned',false,'distinctLookedHashes','[]'::jsonb,'looksUsed',0,'slotsRemaining',2,'maxDistinctLooks',2); end if;
 return scope_dto(sc,coalesce(inherited,false));
end $$;

create function public.report_run(p public.preregistrations, rubric_hash text) returns public.runs language plpgsql stable set search_path = public, pg_temp as $$
declare r runs;
begin
 select rr.* into r from heldout_log l join runs rr on rr.id=l.run_id where l.scope_id=p.scope_id and l.kind='look' and l.rubric_hash=report_run.rubric_hash;
 if not found or r.status<>'complete' then raise exception 'prerequisite_missing: both authorized heldout runs must complete'; end if; return r;
end $$;
create function public.measured_cost(rid text) returns jsonb language sql stable set search_path = public, pg_temp as $$
 select jsonb_build_object('actualUsd',case when count(*) filter(where state in ('claimed','sent','ambiguous'))>0 then null else coalesce(sum(actual_usd),0) end,'attemptedCalls',count(*) filter(where sent_at is not null),'attemptedItems',count(distinct item_key) filter(where sent_at is not null)) from call_attempts where run_id=rid;
$$;
create function public.heldout_report_rows(p_args jsonb) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare p preregistrations; s gold_sets; b runs; c runs; d runs; sc heldout_scopes; contaminated boolean; reasons jsonb:='[]';
begin
 perform require_service(); select * into p from preregistrations where id=p_args->>'preregId'; if not found then raise exception 'not_found: preregistration'; end if;
 perform check_prereg_pins(p); b:=report_run(p,p.pins->>'baselineRubricHash'); c:=report_run(p,p.pins->>'chosenRubricHash');
 select * into s from gold_sets where id=p.set_id; select * into d from runs where id=p.baseline_dev_run_id; select * into sc from heldout_scopes where id=p.scope_id;
 contaminated:=s.inherited_contamination or exists(select 1 from heldout_log where scope_id=sc.id and kind='burn');
 if s.inherited_contamination then reasons:=reasons||jsonb_build_array('set inherits a burned-content re-split'); end if;
 if exists(select 1 from heldout_log where scope_id=sc.id and kind='burn') then reasons:=reasons||jsonb_build_array('scope permanently burned'); end if;
 -- Reuse is mandatory by content/rubric/config. If a burned re-split reuses older evidence,
 -- surface the evidence mismatch rather than relabeling scores from another item universe.
 if exists(select 1 from gold_sets old where old.id in (b.set_id,c.set_id) and (old.split_hash<>s.split_hash or old.annotation_hash<>s.annotation_hash)) then raise exception 'prereg_mismatch: reused heldout evidence belongs to different split/labels'; end if;
 return jsonb_build_object('prereg',prereg_dto(p),'set',set_dto(s),'annotations',coalesce((select jsonb_agg(jsonb_build_object('itemKey',item_key,'annotatorId',annotator_id,'score',score)) from heldout_annotations where set_id=s.id),'[]'),
 'rubrics',coalesce((select jsonb_agg(rubric_dto(rb)) from rubric_versions rb where rb.id in (p.baseline_rubric_id,p.chosen_rubric_id)),'[]'),'judgeConfigs',(select jsonb_build_array(config_dto(j)) from judge_configs j where j.id=p.judge_config_id),
 'baseline',jsonb_build_object('run',run_dto(b),'verdicts',verdict_rows(b.id)),'chosen',jsonb_build_object('run',run_dto(c),'verdicts',verdict_rows(c.id)),'baselineDev',jsonb_build_object('run',run_dto(d),'verdicts',verdict_rows(d.id)),
 'contamination',jsonb_build_object('contaminated',contaminated,'reasons',reasons),'lineage',coalesce((with recursive chain as(select id,parent_set_id,0 depth from gold_sets where id=s.id union all select g.id,g.parent_set_id,c.depth+1 from gold_sets g join chain c on g.id=c.parent_set_id) select jsonb_agg(id order by depth) from chain),'[]'),
 'baselineCost',measured_cost(b.id),'chosenCost',measured_cost(c.id));
end $$;
create function public.list_verdicts(p_args jsonb) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare oid uuid:=owner_uid(); r runs; p preregistrations; b runs; c runs;
begin
 select * into r from runs where id=p_args->>'runId' and owner_id=oid; if not found then raise exception 'forbidden: owned run required'; end if;
 if r.split='heldout' then
   -- Every label/verdict read must be backed by one preregistration with BOTH completed runs.
   select pr.* into p from preregistrations pr join heldout_log l on l.scope_id=pr.scope_id and l.run_id=r.id where pr.owner_id=oid and (pr.pins->>'baselineRubricHash'=l.rubric_hash or pr.pins->>'chosenRubricHash'=l.rubric_hash) order by pr.created_at desc limit 1;
   if not found then raise exception 'forbidden: authorized preregistration required'; end if;
   perform check_prereg_pins(p); b:=report_run(p,p.pins->>'baselineRubricHash'); c:=report_run(p,p.pins->>'chosenRubricHash');
 end if; return verdict_rows(r.id);
end $$;
create function public.public_snapshot(p_args jsonb) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare oid uuid:=owner_uid();
begin
 return jsonb_build_object('mode','live','banner','Public or synthetic data only: do not upload private, personal or confidential text.','owner',oid,
 'sets',coalesce((select jsonb_agg(set_dto(s) order by created_at,id) from gold_sets s where owner_id=oid),'[]'),
 'rubrics',coalesce((select jsonb_agg(rubric_dto(r) order by set_id,version,id) from rubric_versions r where owns_set(set_id)),'[]'),
 'judgeConfigs',coalesce((select jsonb_agg(config_dto(j) order by id) from judge_configs j where owner_id=oid),'[]'),
 'runs',coalesce((select jsonb_agg(run_dto(r) order by created_at,id) from runs r where owner_id=oid),'[]'),
 'suggestions',coalesce((select jsonb_agg(payload order by created_at,id) from suggestions where owner_id=oid),'[]'),
 'rulings',coalesce((select jsonb_agg(ruling_dto(r) order by seq) from rulings r where owner_id=oid),'[]'),
 'preregistrations',coalesce((select jsonb_agg(prereg_dto(p) order by created_at,id) from preregistrations p where owner_id=oid),'[]'),
 'reports','[]'::jsonb,'contamination',coalesce((select jsonb_agg(scope_dto(sc,exists(select 1 from gold_sets g where g.owner_id=oid and g.content_hash=sc.content_hash and g.inherited_contamination)) order by sc.id) from heldout_scopes sc where owner_id=oid),'[]'),
 'budgets',coalesce((select jsonb_agg(budget_dto(b) order by judge_config_id) from budgets b where owner_id=oid),'[]'));
end $$;

-- Cross-table ownership checks also apply to service inserts, preventing malformed lineage.
create function public.run_lineage_guard() returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
 if not exists(select 1 from gold_sets where id=NEW.set_id and owner_id=NEW.owner_id and frozen_at is not null) or not exists(select 1 from rubric_versions where id=NEW.rubric_id and set_id=NEW.set_id) or not exists(select 1 from judge_configs where id=NEW.judge_config_id and owner_id=NEW.owner_id) then raise exception 'forbidden: run parent ownership'; end if;
 if NEW.split='heldout' and not exists(select 1 from heldout_log l join heldout_scopes s on s.id=l.scope_id where l.id=NEW.heldout_look_id and l.kind='look' and l.run_id=NEW.id and s.owner_id=NEW.owner_id and l.prereg_id=NEW.prereg_id) then raise exception 'forbidden: heldout authorization required'; end if;
 if NEW.split='dev' and (NEW.heldout_look_id is not null or NEW.prereg_id is not null) then raise exception 'forbidden: dev run cannot cite heldout look'; end if;
 if TG_OP='UPDATE' and (NEW.owner_id,NEW.set_id,NEW.rubric_id,NEW.judge_config_id,NEW.split,NEW.kind,NEW.heldout_look_id,NEW.prereg_id,NEW.include_probes) is distinct from (OLD.owner_id,OLD.set_id,OLD.rubric_id,OLD.judge_config_id,OLD.split,OLD.kind,OLD.heldout_look_id,OLD.prereg_id,OLD.include_probes) then raise exception 'immutable: run identity'; end if;
 return NEW;
end $$;
create trigger runs_lineage before insert or update on public.runs for each row execute function public.run_lineage_guard();
create function public.prereg_lineage_guard() returns trigger language plpgsql set search_path = public, pg_temp as $$ begin perform check_prereg_pins(NEW); return NEW; end $$;
create trigger prereg_lineage before insert on public.preregistrations for each row execute function public.prereg_lineage_guard();

-- No blanket function EXECUTE grants: service-only ledger/data entrypoints stay service-only.
revoke execute on all functions in schema public from public,anon,authenticated;
grant execute on function public.owns_set(text),public.valid_scale(jsonb),public.current_dev_evidence(text,text) to authenticated;
grant execute on function public.import_set(jsonb),public.freeze_input(jsonb),public.freeze_set(jsonb),public.import_probe_sets(jsonb),public.create_rubric(jsonb),public.create_judge_config(jsonb),public.create_dev_run(jsonb),public.dev_run_rows(jsonb),public.price_book_rows(jsonb),public.append_suggestions(jsonb),public.append_ruling(jsonb),public.set_budget(jsonb),public.resolve_ambiguous(jsonb),public.reconcile_ledger(jsonb),public.public_snapshot(jsonb),public.request_heldout_look(jsonb),public.burn_scope(jsonb),public.scope_status(jsonb),public.list_verdicts(jsonb) to authenticated;
grant execute on function public.acquire_run_lease(jsonb),public.claim_attempt(jsonb),public.mark_sent(jsonb),public.settle_attempt(jsonb),public.fail_before_call(jsonb),public.mark_ambiguous(jsonb),public.release_run_lease(jsonb),public.ensure_run_jobs(jsonb),public.server_set_bundle(jsonb),public.server_run_bundle(jsonb),public.claim_request(jsonb),public.finish_request(jsonb),public.preregister(jsonb),public.heldout_report_rows(jsonb) to service_role;
grant all on all tables in schema public to service_role;
grant usage,select on all sequences in schema public to service_role;
