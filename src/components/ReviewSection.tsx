import React, { useState, useMemo } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  Image,
  Modal,
  StyleSheet,
  Dimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, radius } from '../theme';

const { width: SCREEN_W } = Dimensions.get('window');

// ─── Mock data generators ────────────────────────────────────────────────────

const HIGHLIGHT_POOLS = [
  'Easy to assemble',
  'Great quality',
  'Sturdy build',
  'Looks exactly as pictured',
  'Fast delivery',
  'Perfect fit',
  'Good value',
  'Beautiful finish',
  'Very comfortable',
  'Solid construction',
];

const FIRST_NAMES = ['Sarah', 'James', 'Priya', 'Michael', 'Emma', 'Carlos', 'Liu', 'Fatima', 'Noah', 'Olivia'];
const LAST_INITIALS = ['T.', 'W.', 'R.', 'K.', 'M.', 'B.', 'H.', 'D.', 'L.', 'P.'];

const REVIEW_TITLES = [
  'Absolutely love it!',
  'Solid purchase, no regrets',
  'Exceeded my expectations',
  'Great for the price',
  'Would buy again',
  'Looks even better in person',
  'Assembly was a breeze',
  'Perfect for my space',
  'High quality product',
  'Highly recommend',
  'Decent but has minor flaws',
  'Not what I expected',
];

const REVIEW_BODIES = [
  'The quality is outstanding. I was a bit skeptical ordering furniture online but this exceeded all my expectations. The finish is beautiful and it fits perfectly in my living room.',
  'Assembly took about 45 minutes and the instructions were clear. Everything aligned perfectly. The material feels premium and the color matches the photos exactly.',
  'I have been searching for the right piece for months. This is exactly what I was looking for. The size is perfect and the build quality is impressive.',
  'Great value for the money. My guests always comment on how nice it looks. Delivery was fast and the packaging was secure — no damage at all.',
  'The craftsmanship is really impressive. I love the clean lines and the color is warm and inviting. It blends well with my existing decor.',
  'Ordered two of these and both arrived in perfect condition. The finish is smooth and consistent. Very happy with this purchase overall.',
  'This is my second purchase from Xself Home and again I am impressed. The quality control is consistent and the product looks exactly as described.',
  'I had a minor issue with one component but customer service resolved it immediately. The product itself is beautiful and well made.',
];

const PHOTO_URLS = [
  'https://images.unsplash.com/photo-1555041469-a586c61ea9bc?w=400',
  'https://images.unsplash.com/photo-1493663284031-b7e3aefcae8e?w=400',
  'https://images.unsplash.com/photo-1567538096630-e0c55bd6374c?w=400',
  'https://images.unsplash.com/photo-1524758631624-e2822e304c36?w=400',
  'https://images.unsplash.com/photo-1585559700398-1385b3a8aef6?w=400',
  'https://images.unsplash.com/photo-1556228453-efd6c1ff04f6?w=400',
  'https://images.unsplash.com/photo-1616627451515-cbc80e5ece92?w=400',
  'https://images.unsplash.com/photo-1600585152220-90363fe7e115?w=400',
];

function seeded(seed: number, max: number) {
  return ((seed * 1103515245 + 12345) & 0x7fffffff) % max;
}

function generateReviews(productId: number, count: number) {
  const reviews = [];
  for (let i = 0; i < count; i++) {
    const s1 = seeded(productId * 100 + i, 10000);
    const s2 = seeded(s1, 10000);
    const s3 = seeded(s2, 10000);
    const s4 = seeded(s3, 10000);
    const s5 = seeded(s4, 10000);

    const starRoll = s1 % 10;
    const stars = starRoll < 2 ? 5 : starRoll < 5 ? 4 : starRoll < 7 ? 5 : starRoll < 9 ? 3 : 4;
    const daysAgo = (s2 % 180) + 1;
    const date = new Date(Date.now() - daysAgo * 86400000);
    const hasPhotos = s3 % 3 === 0;
    const photoCount = hasPhotos ? (s4 % 2) + 1 : 0;
    const photos = Array.from({ length: photoCount }, (_, pi) =>
      PHOTO_URLS[(s4 + pi * 17) % PHOTO_URLS.length]
    );

    reviews.push({
      id: `${productId}-${i}`,
      name: `${FIRST_NAMES[s1 % FIRST_NAMES.length]} ${LAST_INITIALS[s2 % LAST_INITIALS.length]}`,
      stars,
      title: REVIEW_TITLES[(s3 % REVIEW_TITLES.length)],
      body: REVIEW_BODIES[s4 % REVIEW_BODIES.length],
      date,
      verified: s5 % 3 !== 0,
      helpful: s1 % 40,
      photos,
    });
  }
  return reviews;
}

function generateReviewData(product: any) {
  const id = product.id ?? 1;
  const totalReviews = product.reviews ?? 24;
  const avgRating = product.rating ?? 4.3;
  const count = Math.min(totalReviews, 12);

  const reviews = generateReviews(id, count);

  // Star breakdown
  const breakdown = [5, 4, 3, 2, 1].map(star => {
    const s = seeded(id * 7 + star, 10000);
    const weights = [0.45, 0.30, 0.13, 0.07, 0.05];
    const base = Math.round(totalReviews * weights[5 - star]);
    return { star, count: Math.max(0, base + (s % 5) - 2) };
  });

  // Highlights
  const hlSeed = seeded(id, 10000);
  const highlights = Array.from({ length: 4 }, (_, i) =>
    HIGHLIGHT_POOLS[(hlSeed + i * 3) % HIGHLIGHT_POOLS.length]
  );

  // Customer photos (distinct subset)
  const photoSeed = seeded(id * 13, 10000);
  const customerPhotos = Array.from({ length: 6 }, (_, i) =>
    PHOTO_URLS[(photoSeed + i * 2) % PHOTO_URLS.length]
  );

  const recPct = Math.round(60 + (seeded(id, 40)));

  return { reviews, breakdown, highlights, customerPhotos, avgRating, totalReviews, recPct };
}

// ─── Star renderer ────────────────────────────────────────────────────────────

function Stars({ value, size = 13 }: { value: number; size?: number }) {
  return (
    <View style={{ flexDirection: 'row', gap: 1 }}>
      {[1, 2, 3, 4, 5].map(i => (
        <Text key={i} style={{ fontSize: size, color: i <= Math.round(value) ? colors.star : colors.border }}>
          ★
        </Text>
      ))}
    </View>
  );
}

// ─── Sort options ─────────────────────────────────────────────────────────────

const SORT_OPTIONS = ['Most Recent', 'Highest Rating', 'Lowest Rating', 'Most Helpful'] as const;
type SortOption = typeof SORT_OPTIONS[number];

function sortReviews(reviews: any[], sort: SortOption) {
  const copy = [...reviews];
  if (sort === 'Most Recent') copy.sort((a, b) => b.date - a.date);
  else if (sort === 'Highest Rating') copy.sort((a, b) => b.stars - a.stars);
  else if (sort === 'Lowest Rating') copy.sort((a, b) => a.stars - b.stars);
  else copy.sort((a, b) => b.helpful - a.helpful);
  return copy;
}

// ─── ReviewSection ────────────────────────────────────────────────────────────

export default function ReviewSection({ product }: { product: any }) {
  const data = useMemo(() => generateReviewData(product), [product.id]);
  const [sort, setSort] = useState<SortOption>('Most Recent');
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [lightboxUri, setLightboxUri] = useState<string | null>(null);
  const [showSortMenu, setShowSortMenu] = useState(false);
  const [showAllReviews, setShowAllReviews] = useState(false);

  const sorted = useMemo(() => sortReviews(data.reviews, sort), [data.reviews, sort]);
  const maxCount = Math.max(...data.breakdown.map(b => b.count), 1);
  const visibleReviews = showAllReviews ? sorted : sorted.slice(0, 2);

  const toggleExpand = (id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  return (
    <View style={styles.section}>
      {/* Section header */}
      <Text style={styles.sectionTitle}>Customer Reviews</Text>

      {/* Summary */}
      <View style={styles.summaryRow}>
        <View style={styles.summaryLeft}>
          <Text style={styles.bigRating}>{data.avgRating.toFixed(1)}</Text>
          <Stars value={data.avgRating} size={18} />
          <Text style={styles.totalReviews}>{data.totalReviews} reviews</Text>
        </View>
        <View style={styles.summaryRight}>
          {data.breakdown.map(({ star, count }) => (
            <View key={star} style={styles.barRow}>
              <Text style={styles.barLabel}>{star}★</Text>
              <View style={styles.barTrack}>
                <View style={[styles.barFill, { width: `${(count / maxCount) * 100}%` }]} />
              </View>
              <Text style={styles.barCount}>{count}</Text>
            </View>
          ))}
        </View>
      </View>

      {/* Recommendation */}
      <View style={styles.recRow}>
        <Ionicons name="checkmark-circle" size={15} color={colors.amber} />
        <Text style={styles.recText}>{data.recPct}% of customers recommend this product</Text>
      </View>

      {/* Top highlights */}
      <View style={styles.highlightsRow}>
        {data.highlights.map(tag => (
          <View key={tag} style={styles.highlightPill}>
            <Text style={styles.highlightText}>{tag}</Text>
          </View>
        ))}
      </View>

      {/* Customer photos */}
      <View style={styles.photoHeader}>
        <Text style={styles.subLabel}>Customer Photos</Text>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.photoList}
      >
        {data.customerPhotos.map((uri, i) => (
          <TouchableOpacity key={i} onPress={() => setLightboxUri(uri)} activeOpacity={0.85}>
            <Image source={{ uri }} style={styles.photoThumb} />
          </TouchableOpacity>
        ))}
      </ScrollView>

      {/* Sort row */}
      <View style={styles.sortRow}>
        <Text style={styles.subLabel}>Reviews</Text>
        <TouchableOpacity style={styles.sortBtn} onPress={() => setShowSortMenu(true)}>
          <Text style={styles.sortBtnText}>{sort}</Text>
          <Ionicons name="chevron-down" size={13} color={colors.textSecondary} />
        </TouchableOpacity>
      </View>

      {/* Reviews list */}
      {visibleReviews.map(review => {
        const expanded = expandedIds.has(review.id);
        const long = review.body.length > 120;
        return (
          <View key={review.id} style={styles.reviewCard}>
            <View style={styles.reviewHeader}>
              <View style={styles.reviewerInfo}>
                <View style={styles.avatar}>
                  <Text style={styles.avatarLetter}>{review.name[0]}</Text>
                </View>
                <View>
                  <Text style={styles.reviewerName}>{review.name}</Text>
                  <Text style={styles.reviewDate}>
                    {review.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                  </Text>
                </View>
              </View>
              {review.verified && (
                <View style={styles.verifiedBadge}>
                  <Ionicons name="checkmark-circle" size={11} color="#CA8A04" />
                  <Text style={styles.verifiedText}>Verified</Text>
                </View>
              )}
            </View>

            <Stars value={review.stars} size={12} />
            <Text style={styles.reviewTitle}>{review.title}</Text>
            <Text style={styles.reviewBody} numberOfLines={expanded || !long ? undefined : 3}>
              {review.body}
            </Text>
            {long && (
              <TouchableOpacity onPress={() => toggleExpand(review.id)}>
                <Text style={styles.readMore}>{expanded ? 'Show less' : 'Read more'}</Text>
              </TouchableOpacity>
            )}

            {review.photos.length > 0 && (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ gap: spacing.sm, marginTop: spacing.sm }}
              >
                {review.photos.map((uri: string, pi: number) => (
                  <TouchableOpacity key={pi} onPress={() => setLightboxUri(uri)} activeOpacity={0.85}>
                    <Image source={{ uri }} style={styles.reviewPhoto} />
                  </TouchableOpacity>
                ))}
              </ScrollView>
            )}

            <View style={styles.helpfulRow}>
              <Ionicons name="thumbs-up-outline" size={12} color={colors.textTertiary} />
              <Text style={styles.helpfulText}>Helpful ({review.helpful})</Text>
            </View>
          </View>
        );
      })}

      {/* Show all reviews */}
      {sorted.length > 2 && (
        <TouchableOpacity style={styles.showMoreBtn} onPress={() => setShowAllReviews(v => !v)}>
          <Text style={styles.showMoreText}>
            {showAllReviews ? 'Show Less' : `Show All Reviews (${sorted.length})`}
          </Text>
          <Ionicons name={showAllReviews ? 'chevron-up' : 'chevron-down'} size={14} color={colors.amber} />
        </TouchableOpacity>
      )}

      {/* Sort menu modal */}
      <Modal
        visible={showSortMenu}
        transparent
        animationType="fade"
        onRequestClose={() => setShowSortMenu(false)}
      >
        <TouchableOpacity style={styles.sortOverlay} activeOpacity={1} onPress={() => setShowSortMenu(false)}>
          <View style={styles.sortMenu}>
            <Text style={styles.sortMenuTitle}>Sort by</Text>
            {SORT_OPTIONS.map(opt => (
              <TouchableOpacity
                key={opt}
                style={styles.sortMenuItem}
                onPress={() => { setSort(opt); setShowSortMenu(false); }}
              >
                <Text style={[styles.sortMenuText, sort === opt && styles.sortMenuTextActive]}>
                  {opt}
                </Text>
                {sort === opt && <Ionicons name="checkmark" size={16} color={colors.amber} />}
              </TouchableOpacity>
            ))}
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Lightbox */}
      <Modal
        visible={!!lightboxUri}
        transparent
        animationType="fade"
        onRequestClose={() => setLightboxUri(null)}
      >
        <TouchableOpacity
          style={styles.lightboxOverlay}
          activeOpacity={1}
          onPress={() => setLightboxUri(null)}
        >
          {lightboxUri && (
            <Image
              source={{ uri: lightboxUri }}
              style={styles.lightboxImage}
              resizeMode="contain"
            />
          )}
          <TouchableOpacity style={styles.lightboxClose} onPress={() => setLightboxUri(null)}>
            <Ionicons name="close" size={22} color="white" />
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xl,
    paddingBottom: spacing.lg,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: colors.textPrimary,
    marginBottom: spacing.lg,
  },

  // Summary
  summaryRow: {
    flexDirection: 'row',
    gap: spacing.lg,
    marginBottom: spacing.md,
  },
  summaryLeft: {
    alignItems: 'center',
    justifyContent: 'center',
    width: 90,
    gap: 4,
  },
  bigRating: {
    fontSize: 40,
    fontWeight: '700',
    color: colors.textPrimary,
    lineHeight: 44,
  },
  totalReviews: {
    fontSize: 11,
    color: colors.textTertiary,
    marginTop: 2,
  },
  summaryRight: {
    flex: 1,
    gap: 5,
    justifyContent: 'center',
  },
  barRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  barLabel: {
    fontSize: 11,
    color: colors.textSecondary,
    width: 20,
    textAlign: 'right',
  },
  barTrack: {
    flex: 1,
    height: 6,
    backgroundColor: colors.muted,
    borderRadius: 3,
    overflow: 'hidden',
  },
  barFill: {
    height: '100%',
    backgroundColor: colors.star,
    borderRadius: 3,
  },
  barCount: {
    fontSize: 11,
    color: colors.textTertiary,
    width: 20,
  },

  // Recommendation
  recRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginBottom: spacing.lg,
  },
  recText: {
    fontSize: 12,
    color: colors.textSecondary,
  },

  // Highlights
  highlightsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginBottom: spacing.lg,
  },
  highlightPill: {
    backgroundColor: '#FEF9EC',
    borderWidth: 1,
    borderColor: '#F5D97A',
    borderRadius: radius.full,
    paddingHorizontal: 12,
    paddingVertical: 5,
  },
  highlightText: {
    fontSize: 12,
    color: '#92660A',
    fontWeight: '500',
  },

  highlightPillMore: {
    backgroundColor: '#F3F1EB',
    borderWidth: 1,
    borderColor: '#D6D0C4',
    borderRadius: radius.full,
    paddingHorizontal: 12,
    paddingVertical: 5,
  },
  highlightTextMore: {
    fontSize: 12,
    color: colors.textSecondary,
    fontWeight: '500',
  },

  // Customer photos
  photoHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.sm,
  },
  subLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textPrimary,
  },
  viewAll: {
    fontSize: 12,
    color: colors.amber,
    fontWeight: '500',
  },
  photoList: {
    gap: spacing.sm,
    paddingBottom: spacing.lg,
  },
  photoThumb: {
    width: 80,
    height: 80,
    borderRadius: 8,
    backgroundColor: colors.muted,
  },

  // Sort
  sortRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.md,
  },
  sortBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.full,
  },
  sortBtnText: {
    fontSize: 12,
    color: colors.textSecondary,
  },

  // Review card
  reviewCard: {
    backgroundColor: colors.surface,
    borderRadius: 8,
    padding: spacing.md,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  reviewHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: spacing.sm,
  },
  reviewerInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  avatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#FEF3C7',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarLetter: {
    fontSize: 14,
    fontWeight: '600',
    color: '#92660A',
  },
  reviewerName: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textPrimary,
  },
  reviewDate: {
    fontSize: 11,
    color: colors.textTertiary,
  },
  verifiedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: '#FEF9EC',
    borderRadius: radius.full,
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  verifiedText: {
    fontSize: 10,
    color: '#92660A',
    fontWeight: '500',
  },
  reviewTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textPrimary,
    marginTop: 5,
    marginBottom: 3,
  },
  reviewBody: {
    fontSize: 13,
    color: colors.textSecondary,
    lineHeight: 19,
  },
  readMore: {
    fontSize: 12,
    color: colors.amber,
    fontWeight: '500',
    marginTop: 3,
  },
  reviewPhoto: {
    width: 72,
    height: 72,
    borderRadius: 6,
    backgroundColor: colors.muted,
  },
  helpfulRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: spacing.sm,
  },
  helpfulText: {
    fontSize: 11,
    color: colors.textTertiary,
  },
  showMoreBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 12,
    marginBottom: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    backgroundColor: colors.surface,
  },
  showMoreText: {
    fontSize: 13,
    color: colors.amber,
    fontWeight: '600',
  },

  // Sort menu
  sortOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.3)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  sortMenu: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: spacing.lg,
    width: 240,
  },
  sortMenuTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.textPrimary,
    marginBottom: spacing.md,
  },
  sortMenuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  sortMenuText: {
    fontSize: 14,
    color: colors.textSecondary,
  },
  sortMenuTextActive: {
    color: colors.amber,
    fontWeight: '600',
  },

  // Lightbox
  lightboxOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.92)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  lightboxImage: {
    width: SCREEN_W,
    height: SCREEN_W,
  },
  lightboxClose: {
    position: 'absolute',
    top: 48,
    right: 20,
    padding: 8,
  },
});
