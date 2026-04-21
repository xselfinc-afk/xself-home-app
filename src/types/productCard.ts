/**
 * Shared card input model.
 *
 * Both ProductCard and DiscoverCard accept this type.
 * Field names intentionally mirror the Product interface so callers can pass
 * Product objects directly — no adapter needed at the call site.
 *
 * Required fields: id, name, images, price
 * Everything else is optional so each card can ignore fields it doesn't use.
 */

export type ProductCardModel = {
  id: string;
  name: string;
  shortTitle?: string;
  displayTitle?: string;
  images: string[];
  price: number;
  originalPrice?: number;
  rating?: number;
  reviewCount?: number;
  category?: string;
  stock?: number;
  isBestSeller?: boolean;
  isFeatured?: boolean;
  sales?: number;
  product_family_key?: string;
  variants?: Array<{
    sku: string;
    color: string;
    size: string;
    price: number;
    stock: number;
    images: string[];
    enabled: boolean;
  }>;
};
