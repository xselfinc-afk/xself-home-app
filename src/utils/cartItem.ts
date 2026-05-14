import type { CartItem } from '../context/CartContext';
import type { ProductVariant } from '../data/products';

export function defaultCartItem(product: any): Omit<CartItem, 'qty'> {
  const firstVariant = product.variants?.find((v: ProductVariant) => v.enabled && v.stock > 0);
  if (firstVariant) {
    return {
      sku: firstVariant.sku,
      productId: product.id,
      name: product.name,
      price: firstVariant.price,
      img: firstVariant.images[0] ?? product.images[0],
      color: firstVariant.color,
      size: firstVariant.size,
    };
  }
  return {
    sku: `product-${product.id}`,
    productId: product.id,
    name: product.name,
    price: product.price,
    img: product.images[0],
    color: '',
    size: '',
  };
}
