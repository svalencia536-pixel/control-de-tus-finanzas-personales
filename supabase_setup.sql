-- ============================================================
--  FINANZAS HOGAR — esquema para Supabase
--  Pégalo completo en:  Supabase → SQL Editor → New query → Run
-- ============================================================

-- ---------- 1. Movimientos (un registro por gasto/ingreso) ----------
create table if not exists public.movimientos (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users on delete cascade,
  tipo        text not null check (tipo in ('gasto','ingreso')),
  fecha       date not null,
  cat         text not null,
  sub         text not null,
  monto       numeric(14,2) not null check (monto > 0),
  cuenta      text,
  det         text,
  created_at  timestamptz not null default now()
);

create index if not exists movimientos_user_fecha_idx
  on public.movimientos (user_id, fecha desc);

-- ---------- 2. Maestros (categorías, subcategorías y presupuestos) ----------
create table if not exists public.maestros (
  user_id     uuid primary key references auth.users on delete cascade,
  cfg         jsonb not null,
  patrimonio  jsonb not null default '{"activos":[],"pasivos":[],"historia":{}}'::jsonb,
  updated_at  timestamptz not null default now()
);

-- Si ya habías creado la tabla antes, esta línea agrega la columna nueva:
alter table public.maestros
  add column if not exists patrimonio jsonb not null
  default '{"activos":[],"pasivos":[],"historia":{}}'::jsonb;

-- ---------- 3. Seguridad a nivel de fila ----------
-- Cada cuenta solo puede ver y tocar SUS propios datos.
-- Como Sergio y Katherin comparten la misma cuenta, ambos ven el mismo presupuesto.

alter table public.movimientos enable row level security;
alter table public.maestros    enable row level security;

drop policy if exists "movimientos propios" on public.movimientos;
create policy "movimientos propios" on public.movimientos
  for all
  using      (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "maestros propios" on public.maestros;
create policy "maestros propios" on public.maestros
  for all
  using      (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ---------- 4. Tiempo real ----------
-- Para que cuando uno registre un gasto, al otro le aparezca solo.
alter publication supabase_realtime add table public.movimientos;
alter publication supabase_realtime add table public.maestros;

-- ============================================================
--  Listo. Deberías ver "Success. No rows returned".
-- ============================================================
