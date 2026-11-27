-- FavecusPlayer 同期用スキーマ（v0.7.0 Step7-1）。Supabaseの「SQL Editor」で1回だけ実行します。
-- 方針：サーバーは「追記されるだけの変更ログ」を保持するだけにする。競合解決（LWW）・整理の判断・Tombstoneの規則は共通JS（shared/）にあり、ここへ複製しない。
-- 秘密情報：クライアントに置くのは anon キーだけ。service_role キーは使わない・置かない。

-- 1) 変更ログ。行は追記のみ（UPDATE不可）。user_id は常に認証済みの利用者本人。
create table if not exists public.sync_changes (
  user_id   uuid   not null default auth.uid() references auth.users(id) on delete cascade,
  seq       bigint not null,
  record_id text   not null check (char_length(record_id) between 3 and 200),
  f         jsonb  not null check (jsonb_typeof(f) = 'object' and pg_column_size(f) <= 16384),
  device_id text   not null check (char_length(device_id) between 1 and 64),
  batch_id  text   not null check (char_length(batch_id) between 1 and 64),
  idx       int    not null check (idx >= 0),
  created_at timestamptz not null default now(),
  primary key (user_id, seq),
  unique (user_id, batch_id, idx)          -- 同じ送信の再試行（応答が失われた場合）が行を増やさない
);
create index if not exists sync_changes_record on public.sync_changes (user_id, record_id);

-- 2) 利用者ごとの連番と、整理（Compact）の境界。
create table if not exists public.sync_meta (
  user_id   uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  last_seq  bigint not null default 0,
  watermark bigint not null default 0      -- これより古いcursorの端末は、差分ではなく全量の再同期になる
);

-- （下の2つの関数は security definer：連番・境界を、クライアントが直接書き換えられないようにするため。どちらも auth.uid() の本人の行だけを扱う）
-- 3) 連番はコミット順にする：同じ利用者の挿入は、利用者単位のロックで直列化し、コミットまで保持する。
--    （identity列は並行トランザクションでコミット順にならず、読み手が小さい番号を永久に取りこぼすおそれがあるため使わない）
create or replace function public.sync_assign_seq() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(new.user_id::text, 7));
  insert into public.sync_meta (user_id, last_seq) values (new.user_id, 1)
    on conflict (user_id) do update set last_seq = public.sync_meta.last_seq + 1
    returning last_seq into new.seq;
  return new;
end $$;
drop trigger if exists sync_changes_seq on public.sync_changes;
create trigger sync_changes_seq before insert on public.sync_changes for each row execute function public.sync_assign_seq();

-- 4) 整理：クライアントが（共通JSの規則で）選んだ、保持期間を過ぎたTombstoneのレコードIDの行を消し、境界を現在の末尾へ進める。
--    削除がなかったときは境界を進めない（進めると、後から参加した端末などが不要な全量再同期になる）。
drop function if exists public.sync_compact(text[]);
create or replace function public.sync_compact(p_ids text[], p_upto bigint) returns bigint
language plpgsql security definer set search_path = '' as $$
declare removed bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text, 7));
  -- p_upto：クライアントが読み取った末尾の連番。それより後に同じレコードへ届いた行がある場合は、そのレコードを消さない（読み取り後の追記を失わない）。
  delete from public.sync_changes c where c.user_id = auth.uid() and c.record_id = any(p_ids)
    and not exists (select 1 from public.sync_changes n where n.user_id = c.user_id and n.record_id = c.record_id and n.seq > p_upto);
  get diagnostics removed = row_count;
  if removed > 0 then
    update public.sync_meta set watermark = last_seq where user_id = auth.uid();
  end if;
  return removed;
end $$;

-- 5) 行単位のアクセス制御（RLS）：自分の行だけ。UPDATEの権限は与えない（追記のみ）。
alter table public.sync_changes enable row level security;
alter table public.sync_meta enable row level security;
drop policy if exists sync_changes_select on public.sync_changes;
drop policy if exists sync_changes_insert on public.sync_changes;
create policy sync_changes_select on public.sync_changes for select to authenticated using (user_id = auth.uid());
create policy sync_changes_insert on public.sync_changes for insert to authenticated with check (user_id = auth.uid());
drop policy if exists sync_meta_select on public.sync_meta;
create policy sync_meta_select on public.sync_meta for select to authenticated using (user_id = auth.uid());

-- 匿名（ログインしていない）アクセスは一切許可しない。
revoke all on public.sync_changes, public.sync_meta from anon, authenticated; -- Supabaseの既定の権限を一度すべて外し、必要なものだけ与える
grant select, insert on public.sync_changes to authenticated; -- 削除は sync_compact（security definer）だけが行う
grant select on public.sync_meta to authenticated; -- 連番と境界はサーバー側の関数だけが更新する（クライアントは読むだけ）
grant execute on function public.sync_compact(text[], bigint) to authenticated;
revoke execute on function public.sync_compact(text[], bigint) from public, anon;
revoke execute on function public.sync_assign_seq() from public, anon, authenticated;

-- ===== v0.7.1：再生回数と「再生回数が少ない曲を優先する」設定の同期 =====
-- 既存の sync_changes（追記型の変更ログ）とは別のテーブル：再生のたびに行が増え続けないよう、1つの行（端末×世代×月×曲）を上書き更新する。
-- v0.7.0 の端末は、このテーブルを読まない（影響を受けない）。Supabaseの「SQL Editor」で、このファイル全体をもう一度実行する（再実行しても安全）。
-- 回数の行を書くのは、その端末だけ（device_id は端末が自分の行にだけ使う）。サーバーは、回数が減る更新を拒む（greatest）。
create table if not exists public.sync_counts (
  user_id   uuid   not null default auth.uid() references auth.users(id) on delete cascade,
  device_id text   not null check (device_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  epoch     int    not null check (epoch >= 0),
  month     text   not null check (month ~ '^(\d{4}-(0[1-9]|1[0-2])|legacy)$'),
  media_key text   not null check (media_key ~ '^(bili:BV[A-Za-z0-9]{10}:p[1-9][0-9]{0,5}|bili-av:[1-9][0-9]{0,17}:p[1-9][0-9]{0,5})$'),
  n         bigint not null check (n >= 1),
  seq       bigint not null default 0,
  primary key (user_id, device_id, epoch, month, media_key)
);
create index if not exists sync_counts_seq on public.sync_counts (user_id, seq);
create table if not exists public.sync_counts_meta (
  user_id  uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  last_seq bigint not null default 0
);
create or replace function public.sync_counts_before() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(new.user_id::text, 11));
  if tg_op = 'UPDATE' then
    if new.n <= old.n then return null; end if; -- 回数が増えない更新はスキップし、不要な連番増加を防ぐ
    new.n := greatest(old.n, new.n); -- 回数は減らない（古い値で上書きされない）
  end if;
  insert into public.sync_counts_meta (user_id, last_seq) values (new.user_id, 1)
    on conflict (user_id) do update set last_seq = public.sync_counts_meta.last_seq + 1
    returning last_seq into new.seq;
  return new;
end $$;
drop trigger if exists sync_counts_seq_trigger on public.sync_counts;
create trigger sync_counts_seq_trigger before insert or update on public.sync_counts for each row execute function public.sync_counts_before();

-- 設定と世代（リセット）：利用者ごとに1行。世代は大きい方が勝ち、設定は新しい時刻（weighted_at、ミリ秒）が勝つ。
create table if not exists public.sync_prefs (
  user_id         uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  epoch           int     not null default 0 check (epoch >= 0),
  weighted_shuffle boolean not null default true,
  weighted_at     bigint  not null default 0 check (weighted_at >= 0)
);
create or replace function public.sync_prefs_before() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    new.epoch := greatest(old.epoch, new.epoch);
    if new.weighted_at <= old.weighted_at then new.weighted_shuffle := old.weighted_shuffle; new.weighted_at := old.weighted_at; end if;
  end if;
  return new;
end $$;
drop trigger if exists sync_prefs_trigger on public.sync_prefs;
create trigger sync_prefs_trigger before insert or update on public.sync_prefs for each row execute function public.sync_prefs_before();

alter table public.sync_counts enable row level security;
alter table public.sync_counts_meta enable row level security;
alter table public.sync_prefs enable row level security;
drop policy if exists sync_counts_select on public.sync_counts;
drop policy if exists sync_counts_insert on public.sync_counts;
drop policy if exists sync_counts_update on public.sync_counts;
create policy sync_counts_select on public.sync_counts for select to authenticated using (user_id = auth.uid());
create policy sync_counts_insert on public.sync_counts for insert to authenticated with check (user_id = auth.uid());
create policy sync_counts_update on public.sync_counts for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists sync_counts_meta_select on public.sync_counts_meta;
create policy sync_counts_meta_select on public.sync_counts_meta for select to authenticated using (user_id = auth.uid());
drop policy if exists sync_prefs_select on public.sync_prefs;
drop policy if exists sync_prefs_insert on public.sync_prefs;
drop policy if exists sync_prefs_update on public.sync_prefs;
create policy sync_prefs_select on public.sync_prefs for select to authenticated using (user_id = auth.uid());
create policy sync_prefs_insert on public.sync_prefs for insert to authenticated with check (user_id = auth.uid());
create policy sync_prefs_update on public.sync_prefs for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
revoke all on public.sync_counts, public.sync_counts_meta, public.sync_prefs from anon, authenticated;
grant select, insert, update on public.sync_counts to authenticated;
grant select on public.sync_counts_meta to authenticated;
grant select, insert, update on public.sync_prefs to authenticated;
revoke execute on function public.sync_counts_before() from public, anon, authenticated;
revoke execute on function public.sync_prefs_before() from public, anon, authenticated;

-- ===== v0.7.5：お気に入り（ハート）と再生履歴（「最近聴いた曲」）の同期 =====
-- 既存テーブル（sync_changes・sync_counts・sync_prefs）には変更を加えない。SQL Editor でこのファイル全体を再実行すれば追加される（再実行安全）。
create table if not exists public.sync_favorites (
  user_id    uuid    not null default auth.uid() references auth.users(id) on delete cascade,
  media_key  text    not null check (media_key ~ '^(bili:BV[A-Za-z0-9]{10}:p[1-9][0-9]{0,5}|bili-av:[1-9][0-9]{0,17}:p[1-9][0-9]{0,5})$'),
  fav        boolean not null,
  updated_at bigint  not null check (updated_at >= 1),
  device_id  text    not null check (device_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  seq        bigint  not null default 0,
  primary key (user_id, media_key)
);
create index if not exists sync_favorites_seq on public.sync_favorites (user_id, seq);
create table if not exists public.sync_favorites_meta (
  user_id  uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  last_seq bigint not null default 0
);
create or replace function public.sync_favorites_before() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(new.user_id::text, 13));
  new.updated_at := least(new.updated_at, floor(extract(epoch from now()) * 1000)::bigint + 600000);
  if tg_op = 'UPDATE' then
    -- 古い時刻・無変化（同時刻かつ既存がfav:trueまたは新もfav:false）では行を更新せず seq を進めない
    if new.updated_at < old.updated_at or (new.updated_at = old.updated_at and (old.fav or not new.fav)) then
      return null;
    end if;
  end if;
  insert into public.sync_favorites_meta (user_id, last_seq) values (new.user_id, 1)
    on conflict (user_id) do update set last_seq = public.sync_favorites_meta.last_seq + 1
    returning last_seq into new.seq;
  return new;
end $$;
drop trigger if exists sync_favorites_seq_trigger on public.sync_favorites;
create trigger sync_favorites_seq_trigger before insert or update on public.sync_favorites for each row execute function public.sync_favorites_before();

create table if not exists public.sync_history (
  user_id    uuid   not null default auth.uid() references auth.users(id) on delete cascade,
  media_key  text   not null check (media_key ~ '^(bili:BV[A-Za-z0-9]{10}:p[1-9][0-9]{0,5}|bili-av:[1-9][0-9]{0,17}:p[1-9][0-9]{0,5})$'),
  played_at  bigint not null check (played_at >= 1),
  device_id  text   not null check (device_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  seq        bigint not null default 0,
  primary key (user_id, media_key)
);
create index if not exists sync_history_seq on public.sync_history (user_id, seq);
create table if not exists public.sync_history_meta (
  user_id  uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  last_seq bigint not null default 0
);
create table if not exists public.sync_history_state (
  user_id    uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  cleared_at bigint not null default 0 check (cleared_at >= 0)
);
create or replace function public.sync_history_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_cleared bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended(new.user_id::text, 17));
  new.played_at := least(new.played_at, floor(extract(epoch from now()) * 1000)::bigint + 600000);
  select cleared_at into v_cleared from public.sync_history_state where user_id = new.user_id;
  if coalesce(v_cleared, 0) >= new.played_at then return null; end if;
  if tg_op = 'UPDATE' and new.played_at <= old.played_at then return null; end if;
  insert into public.sync_history_meta (user_id, last_seq) values (new.user_id, 1)
    on conflict (user_id) do update set last_seq = public.sync_history_meta.last_seq + 1
    returning last_seq into new.seq;
  return new;
end $$;
drop trigger if exists sync_history_seq_trigger on public.sync_history;
create trigger sync_history_seq_trigger before insert or update on public.sync_history for each row execute function public.sync_history_before();

create or replace function public.sync_history_state_before() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(new.user_id::text, 17));
  new.cleared_at := least(new.cleared_at, floor(extract(epoch from now()) * 1000)::bigint + 599000);
  if tg_op = 'UPDATE' and new.cleared_at <= old.cleared_at then return null; end if;
  return new;
end $$;
drop trigger if exists sync_history_state_before_trigger on public.sync_history_state;
create trigger sync_history_state_before_trigger before insert or update on public.sync_history_state for each row execute function public.sync_history_state_before();

create or replace function public.sync_history_state_after() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(new.user_id::text, 17));
  delete from public.sync_history where user_id = new.user_id and played_at <= new.cleared_at;
  return null;
end $$;
drop trigger if exists sync_history_state_after_trigger on public.sync_history_state;
create trigger sync_history_state_after_trigger after insert or update on public.sync_history_state for each row execute function public.sync_history_state_after();

alter table public.sync_favorites enable row level security;
alter table public.sync_favorites_meta enable row level security;
alter table public.sync_history enable row level security;
alter table public.sync_history_meta enable row level security;
alter table public.sync_history_state enable row level security;

drop policy if exists sync_favorites_select on public.sync_favorites;
drop policy if exists sync_favorites_insert on public.sync_favorites;
drop policy if exists sync_favorites_update on public.sync_favorites;
create policy sync_favorites_select on public.sync_favorites for select to authenticated using (user_id = auth.uid());
create policy sync_favorites_insert on public.sync_favorites for insert to authenticated with check (user_id = auth.uid());
create policy sync_favorites_update on public.sync_favorites for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists sync_favorites_meta_select on public.sync_favorites_meta;
create policy sync_favorites_meta_select on public.sync_favorites_meta for select to authenticated using (user_id = auth.uid());

drop policy if exists sync_history_select on public.sync_history;
drop policy if exists sync_history_insert on public.sync_history;
drop policy if exists sync_history_update on public.sync_history;
create policy sync_history_select on public.sync_history for select to authenticated using (user_id = auth.uid());
create policy sync_history_insert on public.sync_history for insert to authenticated with check (user_id = auth.uid());
create policy sync_history_update on public.sync_history for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists sync_history_meta_select on public.sync_history_meta;
create policy sync_history_meta_select on public.sync_history_meta for select to authenticated using (user_id = auth.uid());
drop policy if exists sync_history_state_select on public.sync_history_state;
drop policy if exists sync_history_state_insert on public.sync_history_state;
drop policy if exists sync_history_state_update on public.sync_history_state;
create policy sync_history_state_select on public.sync_history_state for select to authenticated using (user_id = auth.uid());
create policy sync_history_state_insert on public.sync_history_state for insert to authenticated with check (user_id = auth.uid());
create policy sync_history_state_update on public.sync_history_state for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

revoke all on public.sync_favorites, public.sync_favorites_meta, public.sync_history, public.sync_history_meta, public.sync_history_state from anon, authenticated;
grant select, insert, update on public.sync_favorites, public.sync_history, public.sync_history_state to authenticated;
grant select on public.sync_favorites_meta, public.sync_history_meta to authenticated;
revoke execute on function public.sync_favorites_before() from public, anon, authenticated;
revoke execute on function public.sync_history_before() from public, anon, authenticated;
revoke execute on function public.sync_history_state_before() from public, anon, authenticated;
revoke execute on function public.sync_history_state_after() from public, anon, authenticated;

-- ===== v0.7.6：端末ごとのアプリ稼働履歴（7日分保持） =====
-- 既存テーブルには変更を加えない。SQL Editor でこのファイル全体を再実行すれば追加される（再実行安全）。
create table if not exists public.sync_activity_logs (
  user_id    uuid        not null default auth.uid() references auth.users(id) on delete cascade,
  device_id  text        not null check (device_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  day        text        not null check (day ~ '^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'),
  entries    jsonb       not null check (jsonb_typeof(entries) = 'array' and pg_column_size(entries) <= 131072),
  updated_at timestamptz not null default now(),
  primary key (user_id, device_id, day)
);
create index if not exists sync_activity_logs_user_day on public.sync_activity_logs (user_id, day);

alter table public.sync_activity_logs enable row level security;
drop policy if exists sync_activity_logs_select on public.sync_activity_logs;
drop policy if exists sync_activity_logs_insert on public.sync_activity_logs;
drop policy if exists sync_activity_logs_update on public.sync_activity_logs;
drop policy if exists sync_activity_logs_delete on public.sync_activity_logs;
create policy sync_activity_logs_select on public.sync_activity_logs for select to authenticated using (user_id = auth.uid());
create policy sync_activity_logs_insert on public.sync_activity_logs for insert to authenticated with check (user_id = auth.uid());
create policy sync_activity_logs_update on public.sync_activity_logs for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy sync_activity_logs_delete on public.sync_activity_logs for delete to authenticated using (user_id = auth.uid());

revoke all on public.sync_activity_logs from anon, authenticated;
grant select, insert, update, delete on public.sync_activity_logs to authenticated;
