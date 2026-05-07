import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  Modal,
  StyleSheet,
  ActivityIndicator,
  Dimensions,
  KeyboardAvoidingView,
  TextInput,
  Platform,
  Animated,
} from 'react-native';
import { Image } from 'expo-image';
import { variantUrl } from '../utils/imageVariant';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, radius } from '../theme';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { submitReview } from '../services/reviewSubmitter';

const { width: SCREEN_W } = Dimensions.get('window');

// ─── Types ────────────────────────────────────────────────────────────────────

type ReviewRow = {
  id?: string;
  supplier_product_id: string;
  rating: number;
  title: string;
  body: string;
  reviewer_name: string;
  helpful_count: number;
  verified_purchase: boolean;
  is_generated: boolean;
  status: string;
  display_priority: number;
  tags: string[] | null;
  photos?: string[] | null;
  created_at: string;
};

// ─── Derived summary ──────────────────────────────────────────────────────────

function computeSummary(reviews: ReviewRow[]) {
  const total = reviews.length;
  if (total === 0) return null;

  const avg = reviews.reduce((s, r) => s + r.rating, 0) / total;

  const breakdown = [5, 4, 3, 2, 1].map(star => ({
    star,
    count: reviews.filter(r => r.rating === star).length,
  }));

  const recPct = Math.round((reviews.filter(r => r.rating >= 4).length / total) * 100);

  // Flatten all tags from all reviews into a frequency map, take top 4
  const freq: Record<string, number> = {};
  reviews.forEach(r => {
    (r.tags ?? []).forEach(t => { freq[t] = (freq[t] ?? 0) + 1; });
  });
  const highlights = Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([tag]) => tag);

  // Customer photos from review rows that have them
  const customerPhotos: string[] = [];
  reviews.forEach(r => {
    (r.photos ?? []).forEach(uri => {
      if (typeof uri === 'string' && !customerPhotos.includes(uri)) {
        customerPhotos.push(uri);
      }
    });
  });

  return { avg, breakdown, recPct, highlights, customerPhotos, total };
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

// Tier: verified real (0) → unverified real (1) → generated (2)
function reviewTier(r: ReviewRow): number {
  if (r.is_generated) return 2;
  return r.verified_purchase ? 0 : 1;
}

function sortReviews(reviews: ReviewRow[], sort: SortOption): ReviewRow[] {
  return [...reviews].sort((a, b) => {
    // Real reviews always before generated, verified real before unverified
    const tierDiff = reviewTier(a) - reviewTier(b);
    if (tierDiff !== 0) return tierDiff;
    // Within the same tier, apply the chosen sort
    if (sort === 'Most Recent') return b.created_at.localeCompare(a.created_at);
    if (sort === 'Highest Rating') return b.rating - a.rating;
    if (sort === 'Lowest Rating') return a.rating - b.rating;
    return b.helpful_count - a.helpful_count; // Most Helpful
  });
}

// ─── Safe display name for generated reviews ─────────────────────────────────
// Returns "Customer" for seeded reviews so no realistic identity is shown.

function safeDisplayName(review: ReviewRow): string {
  return review.is_generated ? 'Customer' : review.reviewer_name;
}

// ─── ReviewSection ────────────────────────────────────────────────────────────

export default function ReviewSection({ product }: { product: any }) {
  const { user } = useAuth();

  const [reviews, setReviews] = useState<ReviewRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);

  const [sort, setSort] = useState<SortOption>('Most Recent');
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [lightboxUri, setLightboxUri] = useState<string | null>(null);
  const [showSortMenu, setShowSortMenu] = useState(false);
  const [showAllReviews, setShowAllReviews] = useState(false);

  // Write-review modal state
  const [showWriteModal, setShowWriteModal] = useState(false);
  const [writeRating, setWriteRating] = useState(5);
  const [writeTitle, setWriteTitle] = useState('');
  const [writeBody, setWriteBody] = useState('');
  const [writeName, setWriteName] = useState('');
  const [writeSubmitting, setWriteSubmitting] = useState(false);
  const [writeResult, setWriteResult] = useState<string | null>(null);
  const [writeResultType, setWriteResultType] = useState<'success' | 'info' | 'error' | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setReviews([]);

    console.log('[ReviewSection] product.id:', product.id);
    console.log('[ReviewSection] query supplier_product_id:', product.id);

    supabase
      .from('product_reviews')
      .select('*')
      .eq('supplier_product_id', product.id)
      .eq('status', 'active')
      .order('display_priority', { ascending: true })
      .order('created_at', { ascending: false })
      .then(({ data, error }) => {
        if (!active) return;
        console.log('[ReviewSection] rows:', data?.length ?? 0);
        console.log('[ReviewSection] error:', error ?? null);
        console.log('[ReviewSection] first row:', data?.[0] ?? null);
        if (error) {
          setReviews([]);
        } else {
          setReviews((data as ReviewRow[]) ?? []);
        }
        setLoading(false);
      });

    return () => { active = false; };
  }, [product.id, refreshKey]);

  // Hard switch: show ONLY real reviews when any exist; ONLY generated when none do.
  const realReviews = useMemo(() => reviews.filter(r => !r.is_generated), [reviews]);
  const generatedReviews = useMemo(() => reviews.filter(r => r.is_generated).slice(0, 5), [reviews]);
  const realCount = realReviews.length;
  const generatedCount = generatedReviews.length;
  const showingGenerated = realCount === 0;
  const displayedReviews = useMemo(
    () => (realCount === 0 ? generatedReviews : realReviews),
    [realReviews, generatedReviews, realCount],
  );
  const summary = useMemo(() => computeSummary(displayedReviews), [displayedReviews]);
  const sorted = useMemo(() => sortReviews(displayedReviews, sort), [displayedReviews, sort]);
  const visibleReviews = showAllReviews ? sorted : sorted.slice(0, 2);

  useEffect(() => {
    if (loading) return;
    console.log('[Review] real count:', realCount);
    console.log('[Review] generated count:', generatedCount);
    console.log('[Review] final visible count:', sorted.length);
  }, [loading, realCount, generatedCount, sorted.length]);
  const maxBarCount = useMemo(() => Math.max(...(summary?.breakdown.map(b => b.count) ?? [1]), 1), [summary]);

  // Animate distribution bars when summary loads/changes
  const barAnims = useRef([0, 1, 2, 3, 4].map(() => new Animated.Value(0))).current;
  useEffect(() => {
    if (!summary) return;
    Animated.stagger(50, summary.breakdown.map(({ count }, i) =>
      Animated.timing(barAnims[i], {
        toValue: maxBarCount > 0 ? (count / maxBarCount) * 100 : 0,
        duration: 500,
        useNativeDriver: false,
      }),
    )).start();
  }, [summary]);

  const toggleExpand = (id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  // ── Write-review handlers ─────────────────────────────────────────────────────

  function openWriteModal() {
    setWriteRating(5);
    setWriteTitle('');
    setWriteBody('');
    setWriteName(user?.displayName ?? '');
    setWriteResult(null);
    setWriteResultType(null);
    setShowWriteModal(true);
  }

  async function handleSubmitReview() {
    if (writeSubmitting) return;
    setWriteSubmitting(true);
    setWriteResult(null);
    setWriteResultType(null);

    const result = await submitReview({
      supplierProductId: product.id,
      rating: writeRating,
      title: writeTitle,
      body: writeBody,
      reviewerName: writeName.trim() || 'Anonymous',
      userId: user?.id ?? null,
    });

    console.log('[ReviewSubmit] result:', result.ok ? 'ok' : 'fail');
    console.log('[ReviewSubmit] status:', result.savedStatus ?? 'error');

    if (result.ok) {
      // Approved: show success, close after 2s, trigger refresh
      setWriteResult(result.userMessage);
      setWriteResultType('success');
      setWriteSubmitting(false);
      setTimeout(() => {
        setShowWriteModal(false);
        setWriteResult(null);
        setWriteResultType(null);
        setRefreshKey(k => k + 1);
      }, 2000);
    } else if (result.savedStatus === 'hidden') {
      // Pending: show pending message, close after 2s, no refresh
      setWriteResult(result.userMessage);
      setWriteResultType('info');
      setWriteSubmitting(false);
      setTimeout(() => {
        setShowWriteModal(false);
        setWriteResult(null);
        setWriteResultType(null);
      }, 2000);
    } else {
      // Error: show error, keep modal open
      setWriteResult(result.userMessage);
      setWriteResultType('error');
      setWriteSubmitting(false);
    }
  }

  // ── Write-review modal ────────────────────────────────────────────────────────

  const writeReviewModal = (
    <Modal
      visible={showWriteModal}
      transparent
      animationType="slide"
      onRequestClose={() => { if (!writeSubmitting) setShowWriteModal(false); }}
    >
      <KeyboardAvoidingView
        style={styles.modalOverlay}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <TouchableOpacity
          style={StyleSheet.absoluteFillObject}
          activeOpacity={1}
          onPress={() => { if (!writeSubmitting) setShowWriteModal(false); }}
        />
        <View style={styles.modalSheet}>
          <View style={styles.modalHeader}>
            <View>
              <Text style={styles.modalTitle}>Write a Review</Text>
              <Text style={styles.modalSubtitle}>Share your experience to help others decide</Text>
            </View>
            <TouchableOpacity onPress={() => setShowWriteModal(false)} disabled={writeSubmitting}>
              <Ionicons name="close" size={20} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>

          <Text style={styles.modalLabel}>Your Rating</Text>
          <View style={styles.starPicker}>
            {[1, 2, 3, 4, 5].map(s => (
              <TouchableOpacity key={s} onPress={() => setWriteRating(s)} disabled={writeSubmitting}>
                <Text style={{ fontSize: 34, color: s <= writeRating ? colors.star : colors.border }}>★</Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={styles.modalLabel}>Review Title</Text>
          <TextInput
            style={styles.modalInput}
            placeholder="e.g. Great extra storage for the kitchen"
            placeholderTextColor={colors.textTertiary}
            value={writeTitle}
            onChangeText={setWriteTitle}
            maxLength={80}
            editable={!writeSubmitting}
          />

          <Text style={styles.modalLabel}>Your Review</Text>
          <TextInput
            style={[styles.modalInput, styles.modalTextarea]}
            placeholder="What do you like about it? How does it fit in your space?"
            placeholderTextColor={colors.textTertiary}
            value={writeBody}
            onChangeText={setWriteBody}
            multiline
            maxLength={1000}
            editable={!writeSubmitting}
          />

          <Text style={styles.modalLabel}>Your Name</Text>
          <TextInput
            style={styles.modalInput}
            placeholder="Your name (optional)"
            placeholderTextColor={colors.textTertiary}
            value={writeName}
            onChangeText={setWriteName}
            maxLength={40}
            editable={!writeSubmitting}
          />

          {writeResult !== null && (
            <Text style={[
              styles.writeResult,
              writeResultType === 'success' ? styles.writeResultSuccess : styles.writeResultInfo,
            ]}>
              {writeResult}
            </Text>
          )}

          {(() => {
            const canSubmit = writeRating > 0 && writeBody.trim().length >= 10 && !writeSubmitting;
            return (
              <TouchableOpacity
                style={[styles.submitBtn, !canSubmit && styles.submitBtnDisabled]}
                onPress={handleSubmitReview}
                disabled={!canSubmit}
              >
                <Text style={styles.submitBtnText}>
                  {writeSubmitting ? 'Submitting…' : 'Submit Review'}
                </Text>
              </TouchableOpacity>
            );
          })()}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );

  // ── Loading ──────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <View style={[styles.section, styles.centered]}>
        <ActivityIndicator size="small" color={colors.amber} />
        <Text style={styles.stateText}>Loading reviews…</Text>
      </View>
    );
  }

  // ── Empty state ──────────────────────────────────────────────────────────────

  if (reviews.length === 0) {
    return (
      <View style={[styles.section, styles.centered]}>
        <Ionicons name="chatbubble-outline" size={28} color={colors.border} />
        <Text style={styles.stateText}>Be the first to share your experience</Text>
        <TouchableOpacity style={styles.writeReviewBtn} onPress={openWriteModal}>
          <Ionicons name="create-outline" size={14} color={colors.amber} />
          <Text style={styles.writeReviewBtnText}>Write a Review</Text>
        </TouchableOpacity>
        {writeReviewModal}
      </View>
    );
  }

  // ── Populated ────────────────────────────────────────────────────────────────

  return (
    <View style={styles.section}>
      {/* Section header */}
      <View style={styles.sectionHeaderRow}>
        <Text style={styles.sectionTitle}>Customer Reviews</Text>
        <TouchableOpacity style={styles.writeReviewBtn} onPress={openWriteModal}>
          <Ionicons name="create-outline" size={14} color={colors.amber} />
          <Text style={styles.writeReviewBtnText}>Write a Review</Text>
        </TouchableOpacity>
      </View>

      {/* Summary */}
      {summary && (
        <>
          <View style={styles.summaryRow}>
            <View style={styles.summaryLeft}>
              <Text style={styles.bigRating}>{summary.avg.toFixed(1)}</Text>
              <Stars value={summary.avg} size={18} />
              <Text style={styles.totalReviews}>
                {showingGenerated ? 'Based on sample reviews' : `out of 5 · ${summary.total} reviews`}
              </Text>
            </View>
            <View style={styles.summaryRight}>
              {summary.breakdown.map(({ star, count }, i) => (
                <View key={star} style={styles.barRow}>
                  <Text style={styles.barLabel}>{star}★</Text>
                  <View style={styles.barTrack}>
                    <Animated.View style={[styles.barFill, {
                      width: barAnims[i].interpolate({ inputRange: [0, 100], outputRange: ['0%', '100%'] }),
                    }]} />
                  </View>
                  <Text style={styles.barCount}>{count}</Text>
                </View>
              ))}
            </View>
          </View>

          {/* Recommendation — only shown for real reviews */}
          {!showingGenerated && (
            <View style={styles.recRow}>
              <Ionicons name="checkmark-circle" size={15} color={colors.amber} />
              <Text style={styles.recText}>Based on customer feedback</Text>
            </View>
          )}

          {/* Top highlights (tags) */}
          {summary.highlights.length > 0 && (
            <View style={styles.highlightsRow}>
              {summary.highlights.map(tag => (
                <View key={tag} style={styles.highlightPill}>
                  <Text style={styles.highlightText}>{tag}</Text>
                </View>
              ))}
            </View>
          )}

          {/* Customer photos — only shown when reviews have photo URLs */}
          {summary.customerPhotos.length > 0 && (
            <>
              <View style={styles.photoHeader}>
                <Text style={styles.subLabel}>Customer Photos</Text>
              </View>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.photoList}
              >
                {summary.customerPhotos.map((uri, i) => (
                  <TouchableOpacity key={i} onPress={() => setLightboxUri(uri)} activeOpacity={0.85}>
                    <Image source={{ uri: variantUrl(uri, { width: 400 }) }} style={styles.photoThumb} cachePolicy="memory-disk" transition={150} />
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </>
          )}
        </>
      )}

      {/* Sort row */}
      <View style={styles.sortRow}>
        <Text style={styles.subLabel}>Reviews</Text>
        <TouchableOpacity style={styles.sortBtn} onPress={() => setShowSortMenu(true)}>
          <Text style={styles.sortBtnText}>{sort}</Text>
          <Ionicons name="chevron-down" size={13} color={colors.textSecondary} />
        </TouchableOpacity>
      </View>

      {/* Disclosure — only shown when displaying sample reviews */}
      {showingGenerated && (
        <Text style={{ fontSize: 12, color: '#9CA3AF', marginBottom: 8 }}>
          Some reviews are examples to help illustrate product experience.
        </Text>
      )}

      {/* Reviews list */}
      {visibleReviews.map((review, idx) => {
        const rowId = review.id ?? `${review.supplier_product_id}-${idx}`;
        const expanded = expandedIds.has(rowId);
        const long = review.body.length > 120;
        const reviewDate = new Date(review.created_at);
        const photos = review.photos ?? [];

        return (
          <View key={rowId} style={[styles.reviewCard, review.is_generated && styles.reviewCardGenerated]}>
            <View style={styles.reviewHeader}>
              <View style={styles.reviewerInfo}>
                <View style={styles.avatar}>
                  <Text style={styles.avatarLetter}>{safeDisplayName(review)[0]}</Text>
                </View>
                <View>
                  <Text style={styles.reviewerName}>{safeDisplayName(review)}</Text>
                  <Text style={styles.reviewDate}>
                    {reviewDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                  </Text>
                </View>
              </View>
              {review.is_generated ? (
                <View style={styles.sourceBadgeGenerated}>
                  <Text style={styles.sourceBadgeGeneratedText}>Sample Review</Text>
                </View>
              ) : review.verified_purchase ? (
                <View style={styles.sourceBadgeVerified}>
                  <Ionicons name="checkmark-circle" size={11} color="#CA8A04" />
                  <Text style={styles.sourceBadgeVerifiedText}>Verified Purchase</Text>
                </View>
              ) : (
                <View style={styles.sourceBadgeReal}>
                  <Text style={styles.sourceBadgeRealText}>Customer Review</Text>
                </View>
              )}
            </View>

            <Stars value={review.rating} size={12} />
            <Text style={styles.reviewTitle}>{review.title}</Text>
            <Text style={styles.reviewBody} numberOfLines={expanded || !long ? undefined : 3}>
              {review.body}
            </Text>
            {long && (
              <TouchableOpacity onPress={() => toggleExpand(rowId)}>
                <Text style={styles.readMore}>{expanded ? 'Show less' : 'Read more'}</Text>
              </TouchableOpacity>
            )}

            {photos.length > 0 && (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ gap: spacing.sm, marginTop: spacing.sm }}
              >
                {photos.map((uri: string, pi: number) => (
                  <TouchableOpacity key={pi} onPress={() => setLightboxUri(uri)} activeOpacity={0.85}>
                    <Image source={{ uri: variantUrl(uri, { width: 400 }) }} style={styles.reviewPhoto} cachePolicy="memory-disk" transition={150} />
                  </TouchableOpacity>
                ))}
              </ScrollView>
            )}

            <View style={styles.helpfulRow}>
              <Text style={styles.helpfulText}>👍 Helpful ({review.helpful_count})</Text>
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

      {/* Trust signal — only shown for real reviews */}
      {!showingGenerated && (
        <Text style={styles.trustSignal}>Reviews are from verified customers</Text>
      )}

      {/* Write-review modal */}
      {writeReviewModal}

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
              source={{ uri: variantUrl(lightboxUri, { width: 1200, fit: 'contain' }) }}
              style={styles.lightboxImage}
              contentFit="contain"
              cachePolicy="memory-disk"
              transition={150}
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
  centered: {
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xl,
  },
  stateText: {
    fontSize: 13,
    color: colors.textTertiary,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: colors.textPrimary,
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
    backgroundColor: '#FAFAFA',
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: radius.full,
    paddingHorizontal: 12,
    paddingVertical: 5,
  },
  highlightText: {
    fontSize: 12,
    color: colors.textSecondary,
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
  // Review card — generated variant
  reviewCardGenerated: {
    opacity: 0.92,
  },

  // Trust signal
  trustSignal: {
    fontSize: 11,
    color: colors.textTertiary,
    textAlign: 'center',
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
    lineHeight: 16,
  },

  // Modal subtitle
  modalSubtitle: {
    fontSize: 12,
    color: colors.textTertiary,
    marginTop: 2,
  },

  // Source badges
  sourceBadgeVerified: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: '#FEF9EC',
    borderRadius: radius.full,
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  sourceBadgeVerifiedText: {
    fontSize: 10,
    color: '#92660A',
    fontWeight: '500',
  },
  sourceBadgeReal: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.full,
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  sourceBadgeRealText: {
    fontSize: 10,
    color: colors.textTertiary,
    fontWeight: '400',
  },
  sourceBadgeGenerated: {
    borderRadius: radius.full,
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  sourceBadgeGeneratedText: {
    fontSize: 10,
    color: colors.borderFaint,
    fontWeight: '400',
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
    borderRadius: 8,
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

  // Section header row
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.lg,
  },

  // Write a Review CTA button
  writeReviewBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: colors.amber,
    borderRadius: radius.full,
  },
  writeReviewBtnText: {
    fontSize: 12,
    color: colors.amber,
    fontWeight: '600',
  },

  // Write-review modal
  modalOverlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  modalSheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: spacing.lg,
    paddingBottom: 36,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.lg,
  },
  modalTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  modalLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.textSecondary,
    marginBottom: 6,
    marginTop: spacing.md,
  },
  starPicker: {
    flexDirection: 'row',
    gap: 6,
    marginBottom: spacing.sm,
  },
  modalInput: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 9,
    fontSize: 14,
    color: colors.textPrimary,
    backgroundColor: colors.canvas,
  },
  modalTextarea: {
    height: 90,
    textAlignVertical: 'top',
  },
  writeResult: {
    fontSize: 13,
    marginTop: spacing.md,
    textAlign: 'center',
    lineHeight: 18,
  },
  writeResultSuccess: {
    color: '#16a34a',
  },
  writeResultInfo: {
    color: colors.textSecondary,
  },
  submitBtn: {
    marginTop: spacing.lg,
    backgroundColor: colors.amber,
    borderRadius: 8,
    paddingVertical: 13,
    alignItems: 'center',
  },
  submitBtnDisabled: {
    opacity: 0.5,
  },
  submitBtnText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#fff',
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
