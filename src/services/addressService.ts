import { supabase } from '../lib/supabase';

export type Address = {
  id: string;
  user_id: string;
  first_name: string;
  last_name: string;
  phone: string;
  address_line_1: string;
  address_line_2: string | null;
  city: string;
  state: string;
  zip: string;
  country: string;
  is_default: boolean;
  created_at: string;
  updated_at: string;
};

export type AddressInput = {
  first_name: string;
  last_name: string;
  phone: string;
  address_line_1: string;
  address_line_2?: string | null;
  city: string;
  state: string;
  zip: string;
  country?: string;
  is_default?: boolean;
};

export async function fetchAddresses(userId: string): Promise<Address[]> {
  const { data, error } = await supabase
    .from('addresses')
    .select('*')
    .eq('user_id', userId)
    .order('is_default', { ascending: false })
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as Address[];
}

export async function insertAddress(userId: string, input: AddressInput): Promise<Address> {
  const { data, error } = await supabase
    .from('addresses')
    .insert({ ...input, user_id: userId, country: input.country ?? 'US' })
    .select()
    .single();
  if (error) throw error;
  return data as Address;
}

export async function deleteAddress(id: string): Promise<void> {
  const { error } = await supabase.from('addresses').delete().eq('id', id);
  if (error) throw error;
}
