-- Run this whole file in Supabase > SQL Editor
create extension if not exists pgcrypto;

create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null, email text not null,
  role text not null default 'staff' check (role in ('admin','staff')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create table login_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id) on delete cascade,
  full_name text, email text, role text,
  logged_in_at timestamptz not null default now()
);
create table products (
  id uuid primary key default gen_random_uuid(),
  name text not null, category text,
  price numeric(12,2) not null check (price >= 0),
  stock int not null default 0 check (stock >= 0),
  image_url text, active boolean not null default true,
  created_at timestamptz not null default now()
);
create table reports (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid references profiles(id), staff_name text,
  report_date date not null, total_items int not null, total_amount numeric(12,2) not null,
  note text, status text not null default 'pending' check (status in ('pending','approved','rejected')),
  admin_comment text, submitted_at timestamptz not null default now(), reviewed_at timestamptz
);
create table sales (
  id uuid primary key default gen_random_uuid(),
  product_id uuid references products(id), product_name text not null,
  staff_id uuid references profiles(id), staff_name text,
  quantity int not null check (quantity > 0),
  unit_price numeric(12,2) not null, total numeric(12,2) not null,
  sale_date date not null, sold_at timestamptz not null default now(),
  report_id uuid references reports(id) on delete set null
);

-- Only the Node backend (service role key) touches the data.
alter table profiles enable row level security;
alter table login_logs enable row level security;
alter table products enable row level security;
alter table reports enable row level security;
alter table sales enable row level security;

-- Atomic "mark as sold": reduces stock and records the sale in one step.
create or replace function sell_product(p_product uuid, p_staff uuid, p_qty int, p_date date)
returns sales language plpgsql as $$
declare prod products; s sales; sname text;
begin
  update products set stock = stock - p_qty
    where id = p_product and active and stock >= p_qty returning * into prod;
  if not found then raise exception 'Not enough stock left for this item'; end if;
  select full_name into sname from profiles where id = p_staff;
  insert into sales (product_id, product_name, staff_id, staff_name, quantity, unit_price, total, sale_date)
    values (prod.id, prod.name, p_staff, sname, p_qty, prod.price, prod.price * p_qty, p_date)
    returning * into s;
  return s;
end $$;
