-- RLS Rollback: restore open read policies on standardized_products
-- Run this in Supabase SQL Editor if the sellable-only policy needs to be reverted.

DROP POLICY IF EXISTS "Public can read sellable products" ON public.standardized_products;

CREATE POLICY "Allow public read standardized_products"
  ON public.standardized_products FOR SELECT
  USING (true);

CREATE POLICY "Allow authenticated read standardized_products"
  ON public.standardized_products FOR SELECT
  USING (true);
