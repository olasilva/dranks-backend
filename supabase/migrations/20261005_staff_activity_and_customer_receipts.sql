-- Apply to existing databases in Supabase SQL Editor.
alter table sales add column if not exists customer_name text;

create table if not exists activity_logs (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references profiles(id) on delete set null,
  staff_name text not null,
  actor_role text not null check (actor_role in ('admin','staff')),
  action text not null,
  description text not null,
  amount numeric(12,2),
  entity_type text,
  entity_id uuid,
  created_at timestamptz not null default now()
);
create index if not exists activity_logs_created_at_idx on activity_logs (created_at desc);
create unique index if not exists activity_logs_sale_once_idx on activity_logs (entity_type, entity_id, action)
  where entity_type = 'sale' and action = 'Sale / payment';
alter table activity_logs enable row level security;

drop function if exists sell_product(uuid, uuid, integer, date);
create or replace function sell_product(
  p_product uuid,
  p_staff uuid,
  p_qty int,
  p_date date,
  p_customer_name text default null
)
returns sales language plpgsql as $$
declare prod products; s sales; sname text;
begin
  update products set stock = stock - p_qty
    where id = p_product and active and stock >= p_qty returning * into prod;
  if not found then raise exception 'Not enough stock left for this item'; end if;
  select full_name into sname from profiles where id = p_staff;
  insert into sales (product_id, product_name, customer_name, staff_id, staff_name, quantity, unit_price, total, sale_date)
    values (prod.id, prod.name, nullif(btrim(p_customer_name), ''), p_staff, sname, p_qty, prod.price, prod.price * p_qty, p_date)
    returning * into s;
  insert into activity_logs (actor_id, staff_name, actor_role, action, description, amount, entity_type, entity_id)
    values (p_staff, sname, 'staff', 'Sale / payment',
      format('Sold %s x %s%s', s.product_name, s.quantity,
        case when s.customer_name is null then '' else format(' to %s', s.customer_name) end),
      s.total, 'sale', s.id);
  return s;
end $$;

-- Preserve existing sales as payment history in the new admin activity view.
insert into activity_logs (actor_id, staff_name, actor_role, action, description, amount, entity_type, entity_id, created_at)
select s.staff_id, coalesce(s.staff_name, 'Former staff'), 'staff', 'Sale / payment',
  format('Sold %s x %s%s', s.product_name, s.quantity,
    case when s.customer_name is null then '' else format(' to %s', s.customer_name) end),
  s.total, 'sale', s.id, s.sold_at
from sales s
where not exists (
  select 1 from activity_logs a
  where a.entity_type = 'sale' and a.entity_id = s.id and a.action = 'Sale / payment'
);

notify pgrst, 'reload schema';