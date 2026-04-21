import { supabase } from '../lib/supabase';

export type SupplierProduct = {
  id: string;
  supplier_product_id: string;
  title: string;
  description: string | null;
  price: number;
  images: string[];
  inventory: number;
  pickup_address: string | null;
  published: boolean;
  raw_payload: any;
  created_at?: string;
  updated_at?: string;
};

export async function getPublishedSupplierProducts(limit = 60) {
  const { data, error } = await supabase
    .from('supplier_products')
    .select(`
      id,
      supplier_product_id,
      title,
      description,
      price,
      images,
      inventory,
      pickup_address,
      published,
      raw_payload,
      created_at,
      updated_at
    `)
    .eq('published', true)
    .order('updated_at', { ascending: false })
    .limit(limit);

  if (error) {
    throw new Error(`Failed to load supplier products: ${error.message}`);
  }

  return (data ?? []) as SupplierProduct[];
}