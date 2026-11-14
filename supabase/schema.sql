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
