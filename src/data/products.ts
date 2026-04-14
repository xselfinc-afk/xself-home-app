export interface Product {
  id: number;
  name: string;
  price: number;
  sale?: number;        // original price when on sale
  img: string;
  images?: string[];    // carousel images; index 0 matches img
  rating: number;
  reviews: number;
  sales: number;
  hot?: boolean;
  desc: string;
  category: string;
  commission?: number;  // affiliate commission amount (EarnScreen)
}

export const products: Product[] = [
  {
    id: 1,
    name: 'Minimalist Sofa',
    price: 1299,
    sale: 1599,
    img: 'https://images.unsplash.com/photo-1555041469-a586c61ea9bc?w=400',
    images: [
      'https://images.unsplash.com/photo-1555041469-a586c61ea9bc?w=800',
      'https://images.unsplash.com/photo-1493663284031-b7e3aefcae8e?w=800',
    ],
    rating: 4.2,
    reviews: 328,
    sales: 1234,
    hot: true,
    desc: 'Premium minimalist sofa with clean lines and durable fabric. Perfect for modern living rooms.',
    category: 'living',
    commission: 194.85,
  },
  {
    id: 2,
    name: 'Oak Coffee Table',
    price: 449,
    img: 'https://images.unsplash.com/photo-1532372320572-cda25653a26d?w=400',
    images: [
      'https://images.unsplash.com/photo-1532372320572-cda25653a26d?w=800',
      'https://images.unsplash.com/photo-1594620302200-9a762244a156?w=800',
    ],
    rating: 4.8,
    reviews: 156,
    sales: 567,
    desc: 'Solid oak coffee table with a natural finish. Sturdy and timeless.',
    category: 'living',
    commission: 67.35,
  },
  {
    id: 3,
    name: 'Modern Lamp',
    price: 199,
    img: 'https://images.unsplash.com/photo-1506439773649-6e0eb8cfb237?w=400',
    images: [
      'https://images.unsplash.com/photo-1506439773649-6e0eb8cfb237?w=800',
      'https://images.unsplash.com/photo-1600166898405-da9535204843?w=800',
    ],
    rating: 4.5,
    reviews: 89,
    sales: 234,
    desc: 'Sleek modern lamp with adjustable brightness. Fits any contemporary interior.',
    category: 'living',
  },
  {
    id: 4,
    name: 'Velvet Chair',
    price: 599,
    sale: 799,
    img: 'https://images.unsplash.com/photo-1551298370-9d3d53bc4dc3?w=400',
    images: [
      'https://images.unsplash.com/photo-1551298370-9d3d53bc4dc3?w=800',
      'https://images.unsplash.com/photo-1555041469-a586c61ea9bc?w=800',
    ],
    rating: 4.6,
    reviews: 412,
    sales: 2567,
    hot: true,
    desc: 'Luxurious velvet chair with solid wood legs. A statement piece for any room.',
    category: 'living',
    commission: 89.85,
  },
  {
    id: 5,
    name: 'Bookshelf',
    price: 349,
    img: 'https://images.unsplash.com/photo-1594620302200-9a762244a156?w=400',
    images: [
      'https://images.unsplash.com/photo-1594620302200-9a762244a156?w=800',
      'https://images.unsplash.com/photo-1532372320572-cda25653a26d?w=800',
    ],
    rating: 4.3,
    reviews: 78,
    sales: 189,
    desc: 'Modern open bookshelf with 5 shelves. Ideal for books, plants, and decor.',
    category: 'living',
  },
  {
    id: 6,
    name: 'Area Rug',
    price: 279,
    img: 'https://images.unsplash.com/photo-1600166898405-da9535204843?w=400',
    images: [
      'https://images.unsplash.com/photo-1600166898405-da9535204843?w=800',
      'https://images.unsplash.com/photo-1506439773649-6e0eb8cfb237?w=800',
    ],
    rating: 4.7,
    reviews: 203,
    sales: 892,
    desc: 'Soft, hand-woven area rug in a neutral palette. Machine washable.',
    category: 'living',
  },
  {
    id: 7,
    name: 'Dining Chair',
    price: 199,
    img: 'https://images.unsplash.com/photo-1503602642458-2321114458c4?w=400',
    images: [
      'https://images.unsplash.com/photo-1503602642458-2321114458c4?w=800',
      'https://images.unsplash.com/photo-1551298370-9d3d53bc4dc3?w=800',
    ],
    rating: 4.4,
    reviews: 156,
    sales: 456,
    desc: 'Classic dining chair with padded seat. Sold individually, set of 2 available.',
    category: 'dining',
  },
  {
    id: 8,
    name: 'Sectional Sofa',
    price: 899,
    img: 'https://images.unsplash.com/photo-1493663284031-b7e3aefcae8e?w=400',
    images: [
      'https://images.unsplash.com/photo-1493663284031-b7e3aefcae8e?w=800',
      'https://images.unsplash.com/photo-1555041469-a586c61ea9bc?w=800',
    ],
    rating: 4.6,
    reviews: 289,
    sales: 789,
    hot: true,
    desc: 'Large L-shaped sectional sofa. Modular design fits any living room layout.',
    category: 'living',
  },
];
