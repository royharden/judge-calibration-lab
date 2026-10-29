-- Atomic call ledger. All money-changing functions lock budget -> run -> attempt.
create table public.price_book (
 id uuid primary key default gen_random_uuid(), provider text not null check(provider in ('anthropic','openai_compatible','typesafe','mock')), model text not null,
 usd_per_input_mtok numeric not null check(usd_per_input_mtok>=0 and usd_per_input_mtok::text not in ('NaN','Infinity','-Infinity')), usd_per_output_mtok numeric not null check(usd_per_output_mtok>=0 and usd_per_output_mtok::text not in ('NaN','Infinity','-Infinity')), effective_date date not null, source_note text,
 unique(provider,model,effective_date)
);
create table public.budgets (
 owner_id uuid not null references auth.users(id), judge_config_id text not null references public.judge_configs(id), cap_usd numeric not null default 5 check(cap_usd>=0),
 spent_usd numeric not null default 0 check(spent_usd>=0), reserved_usd numeric not null default 0 check(reserved_usd>=0), primary key(owner_id,judge_config_id)
);
create table public.budget_changes (
 seq bigint generated always as identity primary key, owner_id uuid not null references auth.users(id), judge_config_id text not null references public.judge_configs(id),
 old_cap_usd numeric not null, new_cap_usd numeric not null check(new_cap_usd>=0), reason text not null check(length(trim(reason))>0), at timestamptz not null default clock_timestamp()
);
create table public.call_attempts (
 id text primary key default gen_random_uuid()::text, run_id text not null, item_key text not null, replicate integer not null, attempt_no integer not null check(attempt_no between 1 and 2),
 state text not null check(state in ('claimed','sent','settled','failed_before_call','ambiguous','resolved')), claim_token bigint not null, prompt_bytes integer not null check(prompt_bytes>=0),
 price_snapshot jsonb not null, reserved_usd numeric not null check(reserved_usd>=0), actual_usd numeric check(actual_usd>=0), usage jsonb, raw_response text, provider_raw text, reported_model text,
 verdict_ref uuid references public.verdicts(id), cache_key text not null, resolution text check(resolution in ('charge_reserved','release')),
 claimed_at timestamptz not null default clock_timestamp(), sent_at timestamptz, finished_at timestamptz,
 unique(run_id,item_key,replicate,attempt_no), foreign key(run_id,item_key,replicate) references public.run_jobs(run_id,id,ledger_replicate)
);
alter table public.verdicts add constraint verdict_attempt_fk foreign key(attempt_id) references public.call_attempts(id);
create table public.ledger_events (
 seq bigint generated always as identity primary key, kind text not null check(kind in ('reserve','settle','release','ambiguous','resolve')), attempt_id text not null references public.call_attempts(id),
 run_id text not null references public.runs(id), owner_id uuid not null references auth.users(id), judge_config_id text not null references public.judge_configs(id),
 delta_spent_usd numeric not null, delta_reserved_usd numeric not null, at timestamptz not null default clock_timestamp()
);
create table public.response_cache (
 cache_key text primary key, owner_id uuid not null references auth.users(id), provider text not null, model text not null, config_hash text not null, rubric_hash text not null, split text not null check(split in ('dev','heldout')),
 fingerprint text not null, presentation text not null, replicate integer not null, verdict_id uuid not null references public.verdicts(id), created_at timestamptz not null default clock_timestamp()
);
create table public.suggestions (
 id text primary key, owner_id uuid not null references auth.users(id), run_id text not null references public.runs(id), input_hash text not null, payload jsonb not null, created_at timestamptz not null default clock_timestamp()
);
create table public.rulings (
 seq bigint generated always as identity primary key, suggestion_id text not null references public.suggestions(id), owner_id uuid not null references auth.users(id), decision text not null check(decision in ('accept','reject')),
 note text not null default '', input_hash text not null, run_id text not null references public.runs(id), at timestamptz not null default clock_timestamp()
);
create table public.request_receipts (
 owner_id uuid not null references auth.users(id), action text not null check(action in ('score','preregister','report')), request_id text not null check(length(request_id)>0), input_hash text not null,
 state text not null check(state in ('busy','complete')), response jsonb, created_at timestamptz not null default clock_timestamp(), completed_at timestamptz,
 primary key(owner_id,action,request_id)
);
alter table public.price_book enable row level security;
alter table public.budgets enable row level security;
alter table public.budget_changes enable row level security;
alter table public.call_attempts enable row level security;
alter table public.ledger_events enable row level security;
alter table public.response_cache enable row level security;
alter table public.suggestions enable row level security;
alter table public.rulings enable row level security;
alter table public.request_receipts enable row level security;
do $$ declare t text; begin foreach t in array array['price_book','budget_changes','ledger_events','rulings','suggestions','response_cache'] loop execute format('create trigger insert_only before update or delete on public.%I for each row execute function public.append_only()',t); end loop; end $$;
create policy owner_read on public.budgets for select to authenticated using(owner_id=auth.uid() and exists(select 1 from judge_configs j where j.id=judge_config_id and j.owner_id=auth.uid()));
create policy owner_read on public.budget_changes for select to authenticated using(owner_id=auth.uid() and exists(select 1 from judge_configs j where j.id=judge_config_id and j.owner_id=auth.uid()));
create policy owner_read on public.ledger_events for select to authenticated using(owner_id=auth.uid() and exists(select 1 from runs r where r.id=run_id and r.owner_id=auth.uid()));
create policy owner_read on public.suggestions for select to authenticated using(owner_id=auth.uid() and exists(select 1 from runs r where r.id=run_id and r.owner_id=auth.uid() and r.split='dev'));
create policy owner_insert on public.suggestions for insert to authenticated with check(owner_id=auth.uid() and exists(select 1 from runs r where r.id=run_id and r.owner_id=auth.uid() and r.status='complete' and r.split='dev' and r.kind='score' and r.result_hash=input_hash and not exists(select 1 from runs newer where newer.set_id=r.set_id and newer.rubric_id=r.rubric_id and newer.judge_config_id=r.judge_config_id and newer.split='dev' and newer.kind='score' and newer.status='complete' and (newer.completed_at,newer.created_at,newer.id)>(r.completed_at,r.created_at,r.id))));
create policy owner_read on public.rulings for select to authenticated using(owner_id=auth.uid() and exists(select 1 from suggestions s where s.id=suggestion_id and s.owner_id=auth.uid()));
revoke all on public.price_book,public.budgets,public.budget_changes,public.call_attempts,public.ledger_events,public.response_cache,public.suggestions,public.rulings,public.request_receipts from public,anon,authenticated;
grant select on public.budgets,public.budget_changes,public.ledger_events,public.suggestions,public.rulings to authenticated;
grant insert on public.suggestions to authenticated;

create function public.price_dto(p public.price_book) returns jsonb language sql immutable set search_path = public, pg_temp as $$ select jsonb_strip_nulls(jsonb_build_object('provider',p.provider,'model',p.model,'usdPerInputMTok',p.usd_per_input_mtok,'usdPerOutputMTok',p.usd_per_output_mtok,'effectiveDate',p.effective_date,'sourceNote',p.source_note)); $$;
create function public.budget_dto(b public.budgets) returns jsonb language sql immutable set search_path = public, pg_temp as $$ select jsonb_build_object('owner',b.owner_id,'judgeConfigId',b.judge_config_id,'capUsd',b.cap_usd,'spentUsd',b.spent_usd,'reservedUsd',b.reserved_usd); $$;
create function public.ruling_dto(r public.rulings) returns jsonb language sql immutable set search_path = public, pg_temp as $$ select jsonb_build_object('seq',r.seq,'suggestionId',r.suggestion_id,'owner',r.owner_id,'decision',r.decision,'note',r.note,'inputHash',r.input_hash,'runId',r.run_id,'at',r.at); $$;
create function public.price_book_rows(p_args jsonb) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin perform owner_uid(); return coalesce((select jsonb_agg(price_dto(p) order by provider,model,effective_date) from price_book p),'[]'); end $$;
create or replace function public.job_verdict_rows(rid text) returns jsonb language sql stable set search_path = public, pg_temp as $$
 select coalesce(jsonb_agg(jsonb_build_object('jobId',v.item_key,'score',v.score,'unusableReason',v.unusable_reason,'raw',v.raw) order by utf16_key(v.item_key),v.replicate),'[]') from verdicts v where v.run_id=rid;
$$;
create function public.lock_ledger_run(rid text) returns public.runs language plpgsql security definer set search_path = public, pg_temp as $$
declare r runs;
begin
 select * into r from runs where id=rid; if not found then raise exception 'not_found: run'; end if;
 insert into budgets(owner_id,judge_config_id) values(r.owner_id,r.judge_config_id) on conflict do nothing;
 perform 1 from budgets where owner_id=r.owner_id and judge_config_id=r.judge_config_id for update;
 select * into r from runs where id=rid for update; return r;
end $$;
create function public.check_lease(r public.runs, token bigint) returns void language plpgsql set search_path = public, pg_temp as $$
begin
 if token is null or token<>r.claim_token then raise exception 'stale_claim_token: current lease token required'; end if;
 if r.lease_until is null or r.lease_until<=clock_timestamp() then raise exception 'lease_expired: run lease expired'; end if;
end $$;
create function public.ledger_move(k text, a public.call_attempts, r public.runs, spent numeric, reserved numeric) returns void language plpgsql set search_path = public, pg_temp as $$
begin
 update budgets set spent_usd=spent_usd+spent,reserved_usd=reserved_usd+reserved where owner_id=r.owner_id and judge_config_id=r.judge_config_id;
 insert into ledger_events(kind,attempt_id,run_id,owner_id,judge_config_id,delta_spent_usd,delta_reserved_usd) values(k,a.id,r.id,r.owner_id,r.judge_config_id,spent,reserved);
end $$;
create function public.acquire_run_lease(p_args jsonb) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare r runs; a call_attempts; amb jsonb:='[]'; rel jsonb:='[]';
begin
 perform require_service(); r:=lock_ledger_run(p_args->>'runId');
 if not r.jobs_installed then raise exception 'prerequisite_missing: install immutable server jobs first'; end if;
 if r.status='complete' then raise exception 'already_settled: run complete'; end if;
 if r.lease_until>clock_timestamp() then raise exception 'busy: another chunk holds run lease'; end if;
 for a in select * from call_attempts where run_id=r.id and state in ('claimed','sent') order by id for update loop
   if a.state='sent' then
     update call_attempts set state='ambiguous',finished_at=clock_timestamp() where id=a.id;
     perform ledger_move('ambiguous',a,r,0,0); amb:=amb||jsonb_build_array(a.id);
   else
     update call_attempts set state='failed_before_call',finished_at=clock_timestamp() where id=a.id;
     perform ledger_move('release',a,r,0,-a.reserved_usd); rel:=rel||jsonb_build_array(a.id);
   end if;
 end loop;
 update runs set claim_token=claim_token+1,lease_until=clock_timestamp()+interval '60 seconds',status='running' where id=r.id returning * into r;
 return jsonb_build_object('claimToken',r.claim_token,'leaseUntil',extract(epoch from r.lease_until)*1000,'markedAmbiguous',amb,'releasedClaims',rel);
end $$;
create function public.claim_attempt(p_args jsonb) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare r runs; j judge_configs; rb rubric_versions; b budgets; a call_attempts; p price_book; price jsonb; n integer; reserve numeric; bytes integer; job run_jobs; fp text; cache_expected text; ambiguous_id text;
begin
 perform require_service(); r:=lock_ledger_run(p_args->>'runId'); perform check_lease(r,(p_args->>'claimToken')::bigint);
 select * into job from run_jobs where run_id=r.id and id=p_args->>'itemKey' and ledger_replicate=(p_args->>'replicate')::integer;
 if not found then raise exception 'bad_request: unknown immutable job'; end if;
 bytes:=(p_args->>'promptBytes')::integer; if bytes is null or bytes<0 or (p_args->>'promptBytes')::numeric<>bytes or nullif(p_args->>'cacheKey','') is null then raise exception 'bad_request: prompt bytes/cache key'; end if;
 perform 1 from call_attempts where run_id=r.id and item_key=job.id and replicate=job.ledger_replicate and state='settled'; if found then raise exception 'already_settled: never repeat a settled job'; end if;
 select id into ambiguous_id from call_attempts where run_id=r.id and item_key=job.id and replicate=job.ledger_replicate and state='ambiguous' limit 1; if found then raise exception 'attempt_ambiguous: owner resolution required for attempt %',ambiguous_id; end if;
 perform 1 from call_attempts where run_id=r.id and item_key=job.id and replicate=job.ledger_replicate and state in ('claimed','sent'); if found then raise exception 'attempt_in_flight: job already in flight'; end if;
 select count(*) into n from call_attempts where run_id=r.id and item_key=job.id and replicate=job.ledger_replicate; if n>=2 then raise exception 'max_attempts: at most two attempts'; end if;
 select * into j from judge_configs where id=r.judge_config_id;
 select * into rb from rubric_versions where id=r.rubric_id;
 fp:=canonical_hash(jsonb_strip_nulls(jsonb_build_object('task',job.payload->'item'->>'taskText','answer',job.payload->'item'->>'answer','source',nullif(job.payload->'item'->>'source',''),'facts',case when coalesce(job.payload->'item'->'facts','[]')='[]'::jsonb then null else job.payload->'item'->'facts' end)));
 cache_expected:=canonical_hash(jsonb_build_object('owner',r.owner_id,'provider',j.provider,'model',j.model,'decoding',j.params,'promptTemplateVersion',j.prompt_template_version,'rubricHash',rb.content_hash,'levelMapVersion',j.level_map_version,'readout',j.score_readout,'split',r.split,'fingerprint',fp,'presentation',job.payload->>'presentation','replicate',job.replicate));
 if cache_expected is distinct from p_args->>'cacheKey' then raise exception 'prereg_mismatch: scoped cache key'; end if;
 if j.provider='mock' then price:=jsonb_build_object('kind','mock_free','usdPerInputMTok',0,'usdPerOutputMTok',0,'entry',null);
 else
   select * into p from price_book where provider=j.provider and model=j.model order by effective_date desc limit 1;
   if not found then raise exception 'missing_price: live provider has no price book entry'; end if;
   price:=jsonb_build_object('kind','priced','usdPerInputMTok',p.usd_per_input_mtok,'usdPerOutputMTok',p.usd_per_output_mtok,'entry',price_dto(p));
 end if;
 reserve:=(bytes*(price->>'usdPerInputMTok')::numeric+(j.params->>'maxOutputTokens')::integer*(price->>'usdPerOutputMTok')::numeric)/1000000;
 select * into b from budgets where owner_id=r.owner_id and judge_config_id=r.judge_config_id for update;
 if b.spent_usd+b.reserved_usd+reserve>b.cap_usd then raise exception 'budget_exceeded: spent plus reserved plus worst case exceeds cap'; end if;
 insert into call_attempts(run_id,item_key,replicate,attempt_no,state,claim_token,prompt_bytes,price_snapshot,reserved_usd,cache_key)
 values(r.id,job.id,job.ledger_replicate,n+1,'claimed',r.claim_token,bytes,price,reserve,p_args->>'cacheKey') returning * into a;
 perform ledger_move('reserve',a,r,0,reserve);
 return jsonb_build_object('attemptId',a.id,'attemptNo',a.attempt_no,'reservedUsd',reserve);
end $$;
create function public.mark_sent(p_args jsonb) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare r runs; a call_attempts;
begin
 perform require_service(); select * into a from call_attempts where id=p_args->>'attemptId'; if not found then raise exception 'not_found: attempt'; end if;
 r:=lock_ledger_run(a.run_id); perform check_lease(r,(p_args->>'claimToken')::bigint); select * into a from call_attempts where id=a.id for update;
 if a.claim_token<>r.claim_token then raise exception 'stale_claim_token: attempt fencing'; end if;
 if a.state<>'claimed' then raise exception 'invalid_state: only unsent claim can be sent'; end if;
 update call_attempts set state='sent',sent_at=clock_timestamp() where id=a.id; return null;
end $$;
create function public.settle_attempt(p_args jsonb) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare r runs; a call_attempts; job run_jobs; j judge_configs; rb rubric_versions; s gold_sets; v verdicts; v_usage jsonb:=p_args->'usage'; cost numeric; score_n numeric; score_i integer; why text:=p_args->>'unusableReason'; done integer; primary_done integer; rows jsonb; fp text;
begin
 perform require_service(); select * into a from call_attempts where id=p_args->>'attemptId'; if not found then raise exception 'not_found: attempt'; end if;
 r:=lock_ledger_run(a.run_id); perform check_lease(r,(p_args->>'claimToken')::bigint); select * into a from call_attempts where id=a.id for update;
 if a.claim_token<>r.claim_token then raise exception 'stale_claim_token: attempt fencing'; end if;
 if a.state<>'sent' then raise exception 'invalid_state: settle only a sent attempt'; end if;
 if v_usage is null or jsonb_typeof(v_usage->'inputTokens') is distinct from 'number' or jsonb_typeof(v_usage->'outputTokens') is distinct from 'number' or (v_usage->>'inputTokens')::numeric<0 or (v_usage->>'outputTokens')::numeric<0 or (v_usage->>'inputTokens')::numeric<>trunc((v_usage->>'inputTokens')::numeric) or (v_usage->>'outputTokens')::numeric<>trunc((v_usage->>'outputTokens')::numeric) then raise exception 'bad_request: usage token counts'; end if;
 if (p_args->>'score' is null)=(why is null) then raise exception 'bad_request: exactly one score or unusable reason'; end if;
 select * into s from gold_sets where id=r.set_id;
 if p_args->>'score' is not null then
   score_n:=(p_args->>'score')::numeric; if score_n<>trunc(score_n) or score_n<0 or score_n>=jsonb_array_length(s.scale->'levels') then raise exception 'bad_request: score off scale'; end if; score_i:=score_n::integer;
 end if;
 if p_args->>'rawResponse' is null or p_args->>'cacheKey' is distinct from a.cache_key then raise exception 'bad_request: raw response/cache key'; end if;
 cost:=((v_usage->>'inputTokens')::numeric*(a.price_snapshot->>'usdPerInputMTok')::numeric+(v_usage->>'outputTokens')::numeric*(a.price_snapshot->>'usdPerOutputMTok')::numeric)/1000000;
 insert into verdicts(run_id,item_key,replicate,score,unusable_reason,raw,attempt_id) values(r.id,a.item_key,a.replicate,score_i,why,p_args->>'rawResponse',a.id) returning * into v;
 update call_attempts set state='settled',actual_usd=cost,usage=v_usage,raw_response=p_args->>'rawResponse',provider_raw=p_args->>'providerRaw',reported_model=p_args->>'reportedModel',verdict_ref=v.id,finished_at=clock_timestamp() where id=a.id;
 select * into job from run_jobs where run_id=r.id and id=a.item_key and ledger_replicate=a.replicate;
 select * into j from judge_configs where id=r.judge_config_id; select * into rb from rubric_versions where id=r.rubric_id;
 fp:=canonical_hash(jsonb_strip_nulls(jsonb_build_object('task',job.payload->'item'->>'taskText','answer',job.payload->'item'->>'answer','source',nullif(job.payload->'item'->>'source',''),'facts',case when coalesce(job.payload->'item'->'facts','[]')='[]'::jsonb then null else job.payload->'item'->'facts' end)));
 if not coalesce((job.payload->>'cacheBypass')::boolean,false) then
   insert into response_cache(cache_key,owner_id,provider,model,config_hash,rubric_hash,split,fingerprint,presentation,replicate,verdict_id)
   values(a.cache_key,r.owner_id,j.provider,j.model,j.config_hash,rb.content_hash,r.split,fp,job.payload->>'presentation',job.replicate,v.id) on conflict do nothing;
 end if;
 perform ledger_move('settle',a,r,cost,-a.reserved_usd);
 select count(*),count(*) filter(where q.kind='score') into done,primary_done from verdicts z join run_jobs q on q.run_id=z.run_id and q.id=z.item_key and q.ledger_replicate=z.replicate where z.run_id=r.id;
 rows:=verdict_rows(r.id);
 update runs set completed_calls=done,completed_score_items=primary_done,
   status=case when done=planned_calls then 'complete' else status end,
   completed_at=case when done=planned_calls then clock_timestamp() else completed_at end,
   result_hash=case when done=planned_calls then canonical_hash(rows) else null end,
   lease_until=case when done=planned_calls then clock_timestamp() else lease_until end where id=r.id;
 return jsonb_build_object('actualUsd',cost,'verdictRef',v.id);
end $$;
create function public.fail_before_call(p_args jsonb) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare r runs; a call_attempts;
begin
 perform require_service(); select * into a from call_attempts where id=p_args->>'attemptId'; if not found then raise exception 'not_found: attempt'; end if;
 r:=lock_ledger_run(a.run_id); perform check_lease(r,(p_args->>'claimToken')::bigint); select * into a from call_attempts where id=a.id for update;
 if a.claim_token<>r.claim_token then raise exception 'stale_claim_token: attempt fencing'; end if;
 if a.state<>'claimed' then raise exception 'invalid_state: only a never-sent claim can release'; end if;
 update call_attempts set state='failed_before_call',finished_at=clock_timestamp() where id=a.id; perform ledger_move('release',a,r,0,-a.reserved_usd); return null;
end $$;
create function public.mark_ambiguous(p_args jsonb) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare r runs; a call_attempts;
begin
 perform require_service(); select * into a from call_attempts where id=p_args->>'attemptId'; if not found then raise exception 'not_found: attempt'; end if;
 r:=lock_ledger_run(a.run_id); select * into a from call_attempts where id=a.id for update;
 if a.state<>'sent' then raise exception 'invalid_state: only sent attempts become ambiguous'; end if;
 if r.lease_until>clock_timestamp() and r.claim_token=a.claim_token then raise exception 'lease_active: sender lease still active'; end if;
 update call_attempts set state='ambiguous',raw_response=coalesce(p_args->>'rawResponse',raw_response),provider_raw=coalesce(p_args->>'providerRaw',provider_raw),reported_model=coalesce(p_args->>'reportedModel',reported_model),finished_at=clock_timestamp() where id=a.id; perform ledger_move('ambiguous',a,r,0,0); return null;
end $$;
create function public.release_run_lease(p_args jsonb) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare r runs;
begin
 perform require_service(); r:=lock_ledger_run(p_args->>'runId');
 -- The last settle closes its lease. A matching final release remains an idempotent no-op.
 if r.status='complete' and r.claim_token=(p_args->>'claimToken')::bigint then return null; end if;
 perform check_lease(r,(p_args->>'claimToken')::bigint);
 if exists(select 1 from call_attempts where run_id=r.id and state='claimed') then raise exception 'attempt_in_flight: release never-sent claims with fail_before_call first'; end if;
 -- Sent calls retain their reservation. Expiring the lease lets mark_ambiguous record
 -- an unknown provider outcome; a crash here is swept by the next lease acquisition.
 if p_args->>'status'='complete' and r.completed_calls<>r.planned_calls then raise exception 'prerequisite_missing: incomplete run'; end if;
 update runs set lease_until=clock_timestamp(),status=case when completed_calls=planned_calls then 'complete' else 'paused' end where id=r.id; return null;
end $$;
create function public.resolve_ambiguous(p_args jsonb) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare oid uuid:=owner_uid(); r runs; a call_attempts; v_resolution text:=p_args->>'resolution';
begin
 select * into a from call_attempts where id=p_args->>'attemptId'; if not found then raise exception 'not_found: attempt'; end if;
 select * into r from runs where id=a.run_id and owner_id=oid; if not found then raise exception 'forbidden: run owner required'; end if;
 r:=lock_ledger_run(r.id); select * into a from call_attempts where id=a.id for update;
 if a.state<>'ambiguous' then raise exception 'invalid_state: ambiguous attempt required'; end if;
 if v_resolution is null or v_resolution not in ('charge_reserved','release') then raise exception 'bad_request: explicit resolution required'; end if;
 update call_attempts set state='resolved',resolution=v_resolution,actual_usd=case when v_resolution='charge_reserved' then reserved_usd else 0 end,finished_at=clock_timestamp() where id=a.id;
 perform ledger_move('resolve',a,r,case when v_resolution='charge_reserved' then a.reserved_usd else 0 end,-a.reserved_usd); return null;
end $$;
create function public.set_budget(p_args jsonb) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare oid uuid:=owner_uid(); b budgets; cap numeric:=(p_args->>'capUsd')::numeric; reason text:=trim(coalesce(p_args->>'reason',''));
begin
 if cap is null or cap<0 or cap::text in ('NaN','Infinity','-Infinity') or length(reason)=0 then raise exception 'bad_request: finite nonnegative cap and reason required'; end if;
 perform 1 from judge_configs where id=p_args->>'judgeConfigId' and owner_id=oid; if not found then raise exception 'forbidden: judge config owner'; end if;
 insert into budgets(owner_id,judge_config_id) values(oid,p_args->>'judgeConfigId') on conflict do nothing;
 select * into b from budgets where owner_id=oid and judge_config_id=p_args->>'judgeConfigId' for update;
 perform 1 from runs where owner_id=oid and judge_config_id=b.judge_config_id and lease_until>clock_timestamp() for update; if found then raise exception 'lease_active: pause active runs before budget changes'; end if;
 insert into budget_changes(owner_id,judge_config_id,old_cap_usd,new_cap_usd,reason) values(oid,b.judge_config_id,b.cap_usd,cap,reason);
 update budgets set cap_usd=cap where owner_id=oid and judge_config_id=b.judge_config_id returning * into b; return budget_dto(b);
end $$;
create view public.ledger_reconcile with (security_invoker=true) as
 select b.owner_id,b.judge_config_id,b.spent_usd as spent_counter,b.reserved_usd as reserved_counter,
 coalesce(e.spent,0) as spent_from_events,coalesce(e.reserved,0) as reserved_from_events,coalesce(a.reserved,0) as reserved_open_attempts,
 b.spent_usd=coalesce(e.spent,0) and b.reserved_usd=coalesce(e.reserved,0) and b.reserved_usd=coalesce(a.reserved,0) as ok
 from budgets b left join lateral(select sum(delta_spent_usd) spent,sum(delta_reserved_usd) reserved from ledger_events where owner_id=b.owner_id and judge_config_id=b.judge_config_id) e on true
 left join lateral(select sum(c.reserved_usd) reserved from call_attempts c join runs r on r.id=c.run_id where r.owner_id=b.owner_id and r.judge_config_id=b.judge_config_id and c.state in ('claimed','sent','ambiguous')) a on true;
revoke all on public.ledger_reconcile from public,anon,authenticated;
create function public.reconcile_ledger(p_args jsonb) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare oid uuid:=owner_uid(); rows jsonb; good boolean;
begin
 select coalesce(bool_and(ok),true),coalesce(jsonb_agg(jsonb_build_object('owner',owner_id,'judgeConfigId',judge_config_id,'spentCounter',spent_counter,'spentFromEvents',spent_from_events,'reservedCounter',reserved_counter,'reservedFromEvents',reserved_from_events,'reservedOpenAttempts',reserved_open_attempts,'ok',ok)),'[]') into good,rows from ledger_reconcile where owner_id=oid;
 return jsonb_build_object('ok',good,'rows',rows);
end $$;

create function public.current_dev_evidence(rid text, h text) returns boolean language sql stable security definer set search_path = public, pg_temp as $$
 select exists(select 1 from runs r where r.id=rid and r.split='dev' and r.kind='score' and r.status='complete' and r.result_hash=h and not exists(select 1 from runs n where n.owner_id=r.owner_id and n.set_id=r.set_id and n.rubric_id=r.rubric_id and n.judge_config_id=r.judge_config_id and n.split='dev' and n.kind='score' and n.status='complete' and (n.completed_at,n.created_at,n.id)>(r.completed_at,r.created_at,r.id)));
$$;
create function public.suggestion_guard() returns trigger language plpgsql set search_path = public, pg_temp as $$
declare r runs; rb rubric_versions; j judge_configs;
begin
 select * into r from runs where id=NEW.run_id;
 if r.owner_id is distinct from NEW.owner_id or not current_dev_evidence(r.id,NEW.input_hash) then raise exception 'stale: latest completed dev evidence required'; end if;
 select * into rb from rubric_versions where id=r.rubric_id; select * into j from judge_configs where id=r.judge_config_id;
 if NEW.payload->>'suggestionId' is distinct from NEW.id or NEW.payload->>'owner' is distinct from NEW.owner_id::text or NEW.payload->>'runId' is distinct from r.id or NEW.payload->>'inputHash' is distinct from r.result_hash or NEW.payload->>'split' is distinct from 'dev' or NEW.payload->>'setId' is distinct from r.set_id or NEW.payload->>'rubricHash' is distinct from rb.content_hash or NEW.payload->>'judgeConfigHash' is distinct from j.config_hash then raise exception 'bad_request: suggestion lineage mismatch'; end if;
 return NEW;
end $$;
create trigger suggestion_lineage before insert on public.suggestions for each row execute function public.suggestion_guard();
create function public.append_suggestions(p_args jsonb) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare oid uuid:=owner_uid(); r runs; x jsonb; out_rows jsonb:='[]';
begin
 select * into r from runs where id=p_args->>'runId' and owner_id=oid for update;
 if not found then raise exception 'forbidden: run owner'; end if;
 if not current_dev_evidence(r.id,p_args->>'inputHash') then raise exception 'stale: latest completed dev evidence required'; end if;
 for x in select value from jsonb_array_elements(p_args->'suggestions') loop
   insert into suggestions(id,owner_id,run_id,input_hash,payload) values(x->>'suggestionId',oid,r.id,p_args->>'inputHash',x) on conflict do nothing;
   if not exists(select 1 from suggestions where id=x->>'suggestionId' and owner_id=oid and run_id=r.id and input_hash=r.result_hash and payload=x) then raise exception 'bad_request: suggestion id collision'; end if;
   out_rows:=out_rows||jsonb_build_array(x);
 end loop; return out_rows;
end $$;
create function public.append_ruling(p_args jsonb) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare oid uuid:=owner_uid(); s suggestions; r runs; v rulings;
begin
 select * into s from suggestions where id=p_args->>'suggestionId' and owner_id=oid; if not found then raise exception 'forbidden: owned suggestion required'; end if;
 select * into r from runs where id=s.run_id for update;
 if not current_dev_evidence(r.id,s.input_hash) then raise exception 'stale: regenerate against latest completed dev score run'; end if;
 insert into rulings(suggestion_id,owner_id,decision,note,input_hash,run_id) values(s.id,oid,p_args->>'decision',coalesce(p_args->>'note',''),s.input_hash,r.id) returning * into v; return ruling_dto(v);
end $$;

create function public.ensure_run_jobs(p_args jsonb) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare r runs; s gold_sets; x jsonb; j judge_configs; n integer; primary_n integer; plan jsonb:=p_args->'plan'; jobs jsonb:=p_args->'jobs';
begin
 perform require_service(); r:=lock_ledger_run(p_args->>'runId'); select * into s from gold_sets where id=r.set_id; select * into j from judge_configs where id=r.judge_config_id;
 if r.jobs_installed then
   if (select coalesce(jsonb_agg(payload order by utf16_key(id),ledger_replicate),'[]') from run_jobs where run_id=r.id) is distinct from (select coalesce(jsonb_agg(value order by utf16_key(value->>'id'),(value->>'ledgerReplicate')::integer),'[]') from jsonb_array_elements(jobs)) or r.plan is distinct from plan then raise exception 'prereg_mismatch: immutable server jobs/plan changed'; end if; return null;
 end if;
 if r.claim_token<>0 or exists(select 1 from call_attempts where run_id=r.id) or s.frozen_at is null then raise exception 'invalid_state: jobs must precede calls'; end if;
 if jsonb_typeof(jobs) is distinct from 'array' or jsonb_array_length(jobs)=0 or plan->>'provider' is distinct from j.provider or plan->>'model' is distinct from j.model or (plan->>'calls')::integer<>jsonb_array_length(jobs) then raise exception 'bad_request: invalid jobs/plan'; end if;
 for x in select value from jsonb_array_elements(jobs) loop
   if (x->>'replicate')::numeric<>trunc((x->>'replicate')::numeric) or (x->>'ledgerReplicate')::numeric<>trunc((x->>'ledgerReplicate')::numeric) or x->>'presentation' not in ('ascending','reversed') then raise exception 'bad_request: job replicate/presentation'; end if;
   if x->>'kind' in ('score','repeat','order') and not exists(select 1 from items i where i.set_id=r.set_id and i.item_key=x->'item'->>'key' and i.split=r.split and item_dto(i)=x->'item') then raise exception 'forbidden: score/probe job not on run split'; end if;
   if r.split='heldout' and (x->>'kind'<>'score' or (x->>'replicate')::integer<>0 or x->>'presentation'<>'ascending') then raise exception 'forbidden: heldout permits one ascending score job per item'; end if;
   if not r.include_probes and x->>'kind'<>'score' then raise exception 'forbidden: probes not authorized'; end if;
   insert into run_jobs(run_id,id,item_key,replicate,ledger_replicate,kind,payload) values(r.id,x->>'id',x->'item'->>'key',(x->>'replicate')::integer,(x->>'ledgerReplicate')::integer,x->>'kind',x);
 end loop;
 select count(*) into n from items where set_id=r.set_id and split=r.split;
 select count(*) into primary_n from run_jobs where run_id=r.id and kind='score';
 if primary_n<>n or exists(select 1 from run_jobs where run_id=r.id and kind='score' group by item_key having count(*)<>1) or exists(select 1 from run_jobs where run_id=r.id and kind='score' and replicate<>0) then raise exception 'bad_request: primary jobs must cover each split item once'; end if;
 update runs set planned_calls=jsonb_array_length(jobs),score_items=n,plan=plan,worst_case_usd=(plan->>'worstCaseUsd')::numeric,jobs_installed=true where id=r.id; return null;
end $$;
create function public.server_set_bundle(p_args jsonb) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare s gold_sets;
begin
 perform require_service(); select * into s from gold_sets where id=p_args->>'setId'; if not found then raise exception 'not_found: set'; end if;
 return jsonb_build_object('set',set_dto(s),'annotations',coalesce((select jsonb_agg(jsonb_build_object('itemKey',item_key,'annotatorId',annotator_id,'score',score)) from (select item_key,annotator_id,score from dev_annotations where set_id=s.id union all select item_key,annotator_id,score from heldout_annotations where set_id=s.id) a),'[]'),'stagedAnnotations',case when s.frozen_at is null then coalesce((select jsonb_agg(jsonb_build_object('itemKey',item_key,'annotatorId',annotator_id,'score',score)) from annotations_staging where set_id=s.id),'[]') else null end,
 'rubrics',coalesce((select jsonb_agg(rubric_dto(b)) from rubric_versions b where set_id=s.id),'[]'),'judgeConfigs',coalesce((select jsonb_agg(config_dto(j)) from judge_configs j where owner_id=s.owner_id),'[]'),'runs',coalesce((select jsonb_agg(run_dto(r)) from runs r where set_id=s.id and owner_id=s.owner_id),'[]'),'verdicts',coalesce((select jsonb_agg(v) from runs r cross join lateral jsonb_array_elements(verdict_rows(r.id)) v where r.set_id=s.id and r.owner_id=s.owner_id),'[]'));
end $$;
create function public.server_run_bundle(p_args jsonb) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare r runs;
begin
 perform require_service(); select * into r from runs where id=p_args->>'runId'; if not found then raise exception 'not_found: run'; end if;
 if not exists(select 1 from gold_sets where id=r.set_id and owner_id=r.owner_id) or not exists(select 1 from rubric_versions where id=r.rubric_id and set_id=r.set_id) or not exists(select 1 from judge_configs where id=r.judge_config_id and owner_id=r.owner_id) then raise exception 'forbidden: run lineage'; end if;
 return jsonb_build_object('set',(select set_dto(s) from gold_sets s where s.id=r.set_id),'run',run_dto(r),'rubric',(select rubric_dto(b) from rubric_versions b where b.id=r.rubric_id),'config',(select config_dto(j) from judge_configs j where j.id=r.judge_config_id),'jobs',coalesce((select jsonb_agg(payload order by utf16_key(id),ledger_replicate) from run_jobs where run_id=r.id),'[]'),'jobVerdicts',job_verdict_rows(r.id),'prices',coalesce((select jsonb_agg(price_dto(p)) from price_book p),'[]'),'budget',coalesce((select budget_dto(b) from budgets b where owner_id=r.owner_id and judge_config_id=r.judge_config_id),jsonb_build_object('spentUsd',0,'reservedUsd',0,'capUsd',5)));
end $$;
create function public.claim_request(p_args jsonb) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare receipt request_receipts; inserted integer;
begin
 perform require_service();
 insert into request_receipts(owner_id,action,request_id,input_hash,state) values((p_args->>'owner')::uuid,p_args->>'action',p_args->>'requestId',p_args->>'inputHash','busy') on conflict do nothing;
 get diagnostics inserted=row_count;
 select * into receipt from request_receipts where owner_id=(p_args->>'owner')::uuid and action=p_args->>'action' and request_id=p_args->>'requestId' for update;
 if receipt.input_hash is distinct from p_args->>'inputHash' then raise exception 'bad_request: request id reused with different input'; end if;
 return jsonb_strip_nulls(jsonb_build_object('state',case when inserted=1 then 'new' else receipt.state end,'response',receipt.response));
end $$;
create function public.finish_request(p_args jsonb) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare receipt request_receipts;
begin
 perform require_service(); select * into receipt from request_receipts where owner_id=(p_args->>'owner')::uuid and action=p_args->>'action' and request_id=p_args->>'requestId' for update;
 if not found then raise exception 'not_found: request receipt'; end if;
 if receipt.state='complete' then if receipt.response is distinct from p_args->'response' then raise exception 'invalid_state: completed receipt immutable'; end if; return null; end if;
 if jsonb_typeof(p_args->'response'->'ok') is distinct from 'boolean' then raise exception 'bad_request: response envelope'; end if;
 update request_receipts set state='complete',response=p_args->'response',completed_at=clock_timestamp() where owner_id=receipt.owner_id and action=receipt.action and request_id=receipt.request_id; return null;
end $$;

revoke execute on all functions in schema public from public,anon,authenticated;
grant execute on function public.owns_set(text),public.valid_scale(jsonb),public.current_dev_evidence(text,text) to authenticated;
grant execute on function public.import_set(jsonb),public.freeze_input(jsonb),public.freeze_set(jsonb),public.import_probe_sets(jsonb),public.create_rubric(jsonb),public.create_judge_config(jsonb),public.create_dev_run(jsonb),public.dev_run_rows(jsonb),public.price_book_rows(jsonb),public.append_suggestions(jsonb),public.append_ruling(jsonb),public.set_budget(jsonb),public.resolve_ambiguous(jsonb),public.reconcile_ledger(jsonb) to authenticated;
grant execute on function public.acquire_run_lease(jsonb),public.claim_attempt(jsonb),public.mark_sent(jsonb),public.settle_attempt(jsonb),public.fail_before_call(jsonb),public.mark_ambiguous(jsonb),public.release_run_lease(jsonb),public.ensure_run_jobs(jsonb),public.server_set_bundle(jsonb),public.server_run_bundle(jsonb),public.claim_request(jsonb),public.finish_request(jsonb) to service_role;
grant all on all tables in schema public to service_role;
grant usage,select on all sequences in schema public to service_role;
