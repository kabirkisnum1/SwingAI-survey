-- Run once in Supabase SQL Editor for Swing AI Survey persistence.

create table if not exists public.survey_responses (
  id uuid primary key,
  received_at timestamptz not null default now(),
  submitted_at timestamptz,
  payload jsonb not null
);

alter table public.survey_responses
  add column if not exists received_at timestamptz not null default now();

alter table public.survey_responses
  add column if not exists submitted_at timestamptz;

alter table public.survey_responses
  add column if not exists payload jsonb;

alter table public.survey_responses
  alter column submitted_at drop not null;

create index if not exists survey_responses_submitted_at_idx
  on public.survey_responses (submitted_at desc nulls last);

create index if not exists survey_responses_received_at_idx
  on public.survey_responses (received_at desc);

grant all on table public.survey_responses to service_role;
