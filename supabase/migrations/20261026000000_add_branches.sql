-- ============================================================
-- Multi-branch support
-- ============================================================

-- 1. Branches table
CREATE TABLE IF NOT EXISTS branches (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO branches (name) VALUES
  ('Kurudu Phase 5'),
  ('Loko, Orozo Karishi')
ON CONFLICT (name) DO NOTHING;

-- 2. Add branch_id everywhere it matters
ALTER TABLE profiles      ADD COLUMN IF NOT EXISTS branch_id BIGINT REFERENCES branches(id);
ALTER TABLE products      ADD COLUMN IF NOT EXISTS branch_id BIGINT REFERENCES branches(id);
ALTER TABLE sales         ADD COLUMN IF NOT EXISTS branch_id BIGINT REFERENCES branches(id);
ALTER TABLE reports       ADD COLUMN IF NOT EXISTS branch_id BIGINT REFERENCES branches(id);
ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS branch_id BIGINT REFERENCES branches(id);
ALTER TABLE login_logs    ADD COLUMN IF NOT EXISTS branch_id BIGINT REFERENCES branches(id);

-- 3. Indexes for branch filtering
CREATE INDEX IF NOT EXISTS idx_products_branch ON products(branch_id);
CREATE INDEX IF NOT EXISTS idx_sales_branch    ON sales(branch_id);
CREATE INDEX IF NOT EXISTS idx_reports_branch  ON reports(branch_id);
CREATE INDEX IF NOT EXISTS idx_activity_branch ON activity_logs(branch_id);
CREATE INDEX IF NOT EXISTS idx_logins_branch   ON login_logs(branch_id);
CREATE INDEX IF NOT EXISTS idx_profiles_branch ON profiles(branch_id);

-- 4. sell_product RPC with branch stamping
CREATE OR REPLACE FUNCTION sell_product(
  p_product       BIGINT,
  p_staff         UUID,
  p_qty           INT,
  p_date          DATE,
  p_customer_name TEXT DEFAULT NULL
) RETURNS sales AS $$
DECLARE
  prod   products;
  branch BIGINT;
  staff_name TEXT;
  row    sales;
BEGIN
  SELECT * INTO prod FROM products WHERE id = p_product AND active = TRUE FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Product not found'; END IF;
  IF prod.stock < p_qty THEN RAISE EXCEPTION 'Not enough stock (% left)', prod.stock; END IF;

  SELECT branch_id, full_name INTO branch, staff_name FROM profiles WHERE id = p_staff;

  UPDATE products SET stock = stock - p_qty WHERE id = p_product;

  INSERT INTO sales (
    product_id, product_name, staff_id, staff_name,
    quantity, total, sale_date, sold_at, customer_name, branch_id
  ) VALUES (
    p_product, prod.name, p_staff, staff_name,
    p_qty, prod.price * p_qty, p_date, NOW(), p_customer_name, branch
  ) RETURNING * INTO row;

  RETURN row;
END;
$$ LANGUAGE plpgsql;