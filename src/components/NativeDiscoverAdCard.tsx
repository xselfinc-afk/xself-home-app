/**
 * NativeDiscoverAdCard — a single full-width, COMPACT HORIZONTAL Native Advanced
 * ad rendered inline inside the Discover feed (never popup/overlay/modal/full-screen).
 *
 * Layout (deterministic FIXED height 140 pt — media on the left, text on the right):
 *
 *   ┌───────────────────────────────────────────┐
 *   │ Sponsored                             (ⓘ) │  header row (18) — AdChoices top-right
 *   │ ┌──────────┐  Headline (≤2 lines)         │
 *   │ │  Media   │  Advertiser (≤1 line)         │  body row (100) — media 124×100
 *   │ └──────────┘                     [ CTA ]   │
 *   └───────────────────────────────────────────┘
 *
 * The media lives in its own FIXED-size (124×100), overflow-clipped container, and
 * the body row itself is a fixed 100-pt height, so the NativeMediaView can NEVER
 * control or increase the card height, and assets never overlap. No body text.
 *
 * Google Native compliance: every rendered asset is inside a single <NativeAdView>;
 * the media uses <NativeMediaView> (registered); headline/advertiser/CTA are each
 * wrapped in <NativeAsset> with the correct assetType; the CTA shows the exact SDK
 * callToAction text; the top-right is kept clear so the SDK AdChoices overlay is
 * unobstructed; no absolute positioning / no overlapping asset views; media width
 * (124) meets the prominence minimum.
 *
 * Lifecycle: async load (never blocks Discover / startup); compact skeleton while
 * loading; NO_FILL/error → null (collapses cleanly); destroys the NativeAd on
 * unmount; loads once per mount; dev-only logs; no service-role credentials.
 */

import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import {
  NativeAd,
  NativeAdView,
  NativeMediaView,
  NativeAsset,
  NativeAssetType,
} from 'react-native-google-mobile-ads';
import { resolveNativeAdUnitId } from '../config/ads';

const MEDIA_WIDTH = 124;  // ≥120 for media prominence
const MEDIA_HEIGHT = 100; // fixed — media never drives the card height
const BODY_ROW_HEIGHT = 100;

type Props = {
  /** From remote config ads_native_test_mode — TEST ads unless explicitly false. */
  testMode: boolean;
};

export default function NativeDiscoverAdCard({ testMode }: Props) {
  const [nativeAd, setNativeAd] = useState<NativeAd | null>(null);
  const [status, setStatus] = useState<'loading' | 'loaded' | 'failed'>('loading');
  const adRef = useRef<NativeAd | null>(null);

  const unitId = resolveNativeAdUnitId(testMode);

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');

    NativeAd.createForAdRequest(unitId, { requestNonPersonalizedAdsOnly: true })
      .then(ad => {
        if (cancelled) { ad.destroy(); return; } // unmounted before load resolved
        adRef.current = ad;
        setNativeAd(ad);
        setStatus('loaded');
        if (__DEV__) console.log('[NativeAd] loaded:', ad.headline);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setStatus('failed'); // NO_FILL or error → collapse, show products only
        if (__DEV__) console.warn('[NativeAd] load failed:', e instanceof Error ? e.message : e);
      });

    return () => {
      cancelled = true;
      if (adRef.current) { adRef.current.destroy(); adRef.current = null; }
    };
  }, [unitId]);

  // Failure / no-fill → take no space so products flow normally.
  if (status === 'failed') return null;

  // Loading → compact skeleton mirroring the final horizontal layout/height (no jump).
  if (status === 'loading' || !nativeAd) {
    return (
      <View style={styles.card}>
        <View style={styles.header}>
          <Text style={styles.sponsored}>Sponsored</Text>
        </View>
        <View style={styles.bodyRow}>
          <View style={[styles.mediaContainer, styles.mediaSkeleton]} />
          <View style={styles.textCol}>
            <View style={styles.lineSkeletonWide} />
            <View style={styles.lineSkeletonNarrow} />
          </View>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.card}>
      <NativeAdView nativeAd={nativeAd} style={styles.adView}>
        {/* Header: "Sponsored" top-left; top-right kept clear for the SDK AdChoices overlay. */}
        <View style={styles.header}>
          <Text style={styles.sponsored}>Sponsored</Text>
        </View>

        <View style={styles.bodyRow}>
          {/* Media in its own FIXED-size, clipped container — cannot grow the card. */}
          <View style={styles.mediaContainer}>
            <NativeMediaView style={styles.media} resizeMode="cover" />
          </View>

          <View style={styles.textCol}>
            <View style={styles.textTop}>
              <NativeAsset assetType={NativeAssetType.HEADLINE}>
                <Text style={styles.headline} numberOfLines={2}>{nativeAd.headline}</Text>
              </NativeAsset>

              {nativeAd.advertiser ? (
                <NativeAsset assetType={NativeAssetType.ADVERTISER}>
                  <Text style={styles.advertiser} numberOfLines={1}>{nativeAd.advertiser}</Text>
                </NativeAsset>
              ) : null}
            </View>

            {nativeAd.callToAction ? (
              <View style={styles.ctaRow}>
                <NativeAsset assetType={NativeAssetType.CALL_TO_ACTION}>
                  {/* Exact SDK callToAction text — restrained outlined pill, NOT gold Add-to-Cart. */}
                  <Text style={styles.cta} numberOfLines={1}>{nativeAd.callToAction}</Text>
                </NativeAsset>
              </View>
            ) : null}
          </View>
        </View>
      </NativeAdView>
    </View>
  );
}

const styles = StyleSheet.create({
  // Full-width inline card aligned with the Discover grid's outer edges (grid gridItem
  // margin is 3 inside feed paddingHorizontal 8). Fixed height: 8 + 18 + 6 + 100 + 8 = 140.
  card: {
    marginHorizontal: 3,
    marginVertical: 6,
    borderRadius: 6,
    backgroundColor: '#FFFFFF',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#E5E3DC',
    overflow: 'hidden',
    paddingHorizontal: 10,
    paddingTop: 8,
    paddingBottom: 8,
  },
  adView: {
    width: '100%',
  },
  header: {
    height: 18,
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 6,
  },
  sponsored: {
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.4,
    color: '#9CA3AF',
  },
  bodyRow: {
    flexDirection: 'row',
    height: BODY_ROW_HEIGHT, // fixed → card height is deterministic (140 pt)
  },
  mediaContainer: {
    width: MEDIA_WIDTH,
    height: MEDIA_HEIGHT,
    borderRadius: 4,
    overflow: 'hidden',
    backgroundColor: '#E5E3DC',
  },
  media: {
    width: '100%',
    height: '100%',
  },
  mediaSkeleton: {
    backgroundColor: '#E0DED7',
  },
  textCol: {
    flex: 1,
    marginLeft: 12,
    justifyContent: 'space-between', // headline/advertiser at top, CTA at bottom
  },
  textTop: {},
  headline: {
    fontSize: 14,
    lineHeight: 18,
    fontWeight: '600',
    color: '#1C1917',
  },
  advertiser: {
    fontSize: 12,
    color: '#78716C',
    marginTop: 3,
  },
  ctaRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
  },
  // Small restrained outlined pill — not full-width, not gold, not visually dominant.
  cta: {
    fontSize: 12,
    fontWeight: '600',
    color: '#1C1917',
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#E5E3DC',
    overflow: 'hidden',
  },
  lineSkeletonWide: {
    height: 12,
    borderRadius: 3,
    backgroundColor: '#E0DED7',
    width: '90%',
  },
  lineSkeletonNarrow: {
    height: 12,
    borderRadius: 3,
    backgroundColor: '#E0DED7',
    marginTop: 8,
    width: '55%',
  },
});
