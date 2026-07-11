/**
 * NativeDiscoverAdCard — ONE quiet, full-width horizontal Native Advanced card
 * rendered inline in the Discover feed (never popup/overlay/modal/full-screen).
 * It reads like a calm recommendation card and preserves the browsing rhythm.
 *
 *   ┌────────────────────────────────────────────────┐
 *   │ Ad                                        (ⓘ)  │  header ~18 — AdChoices top-right
 *   │ ┌──────────────┐  Headline (≤2 lines)          │
 *   │ │              │  Advertiser (≤1)               │
 *   │ │  MediaView   │                                │
 *   │ │   120×120    │                     [ CTA ]    │
 *   │ └──────────────┘                                │
 *   └────────────────────────────────────────────────┘   total ~154 pt (hard max 158)
 *
 * Resolves the two on-device AdMob Native Validator issues:
 *   1) "MediaView is too small for video" → MediaView container is exactly 120×120
 *      (iOS minimum), fixed + overflow-clipped, so it satisfies the minimum yet can
 *      never grow the card height.
 *   2) "Advertiser assets outside native ad view" → the <NativeAdView> IS the card
 *      container (border/radius/background/padding applied to it); ALL registered
 *      assets are padded children well inside its bounds, so no asset boundary
 *      (advertiser included) can fall outside the NativeAdView. The only outer view
 *      is a margin-only wrapper carrying no ad assets.
 *
 * Compliance: single <NativeAdView> contains the "Ad" label, <NativeMediaView>,
 * headline, advertiser and CTA; each text asset is wrapped in <NativeAsset> with the
 * correct assetType; CTA is a plain <Text> (no Touchable / onPress) so the SDK owns
 * the click; NO overflow:hidden on the NativeAdView/card (only the media container
 * clips) so AdChoices is never clipped; top-right kept clear; no body text; no
 * negative margins / transforms / absolute offsets. Media uses resizeMode="contain"
 * (image aspect preserved, full video kept inside the 120×120 box).
 *
 * Lifecycle: async load (never blocks Discover/startup); compact skeleton while
 * loading; NO_FILL/error → null (collapses); NativeAd destroyed on unmount (and if it
 * resolves after unmount); loads once per mount; dev-only logs; no secrets.
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

const MEDIA_SIZE = 120;       // iOS Native MediaView minimum (fixes "MediaView too small for video")
const CONTENT_ROW_HEIGHT = 120;

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

  // Loading → compact skeleton mirroring the final height (no oversized blank, no jump).
  if (status === 'loading' || !nativeAd) {
    return (
      <View style={styles.outer}>
        <View style={styles.card}>
          <View style={styles.header}><Text style={styles.adLabel}>Ad</Text></View>
          <View style={styles.contentRow}>
            <View style={[styles.mediaContainer, styles.skeleton]} />
            <View style={styles.textCol}>
              <View>
                <View style={styles.lineSkeletonWide} />
                <View style={styles.lineSkeletonNarrow} />
              </View>
            </View>
          </View>
        </View>
      </View>
    );
  }

  // Skip a creative that cannot be shown correctly in the compact layout.
  if (!nativeAd.headline) return null;

  return (
    // Outer wrapper carries ONLY the feed margins — it holds no ad assets, so every
    // registered asset lives inside the NativeAdView below.
    <View style={styles.outer}>
      <NativeAdView nativeAd={nativeAd} style={styles.card}>
        {/* "Ad" attribution top-left; top-right kept clear for the SDK AdChoices overlay. */}
        <View style={styles.header}><Text style={styles.adLabel}>Ad</Text></View>

        <View style={styles.contentRow}>
          {/* 120×120 MediaView in a fixed, clipped container — meets the iOS minimum yet
              never drives the card height. */}
          <View style={styles.mediaContainer}>
            <NativeMediaView style={styles.media} resizeMode="contain" />
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
                  {/* Exact SDK CTA text — small quiet outlined pill, NOT the gold Add-to-Cart
                      button; plain <Text> so the SDK click handler is never intercepted. */}
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
  // Margins only — positions the card in the feed, aligned with the grid edges.
  outer: {
    marginHorizontal: 3,
    marginVertical: 6,
  },
  // The NativeAdView itself: border/radius/background + padding. All ad assets are
  // padded children of this, so every asset boundary stays inside NativeAdView.
  // NO overflow:'hidden' here (only on the media container) so AdChoices isn't clipped.
  // Height = 6 + 18 + 4 + 120 + 6 = 154 pt.
  card: {
    borderRadius: 6,
    backgroundColor: '#FFFFFF',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#E5E3DC',
    paddingHorizontal: 12,
    paddingTop: 6,
    paddingBottom: 6,
  },
  header: {
    height: 18,
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4,
  },
  adLabel: {
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.4,
    color: '#78716C', // muted gray, medium weight — clearly visible, not dominant
  },
  contentRow: {
    flexDirection: 'row',
    height: CONTENT_ROW_HEIGHT, // fixed → deterministic card height
  },
  mediaContainer: {
    width: MEDIA_SIZE,
    height: MEDIA_SIZE,
    borderRadius: 6,
    overflow: 'hidden', // clip media only (never the card / AdChoices)
    backgroundColor: '#ECEAE2',
  },
  media: { width: '100%', height: '100%' },
  skeleton: { backgroundColor: '#E0DED7' },
  textCol: {
    flex: 1,
    marginLeft: 12,
    height: CONTENT_ROW_HEIGHT,
    justifyContent: 'space-between', // headline/advertiser at top, CTA pinned bottom
    paddingVertical: 4,
  },
  textTop: {},
  headline: {
    fontSize: 14,
    lineHeight: 18,
    fontWeight: '600',
    color: '#1C1917', // matches product-title text color
  },
  advertiser: {
    fontSize: 12,
    color: '#78716C',
    marginTop: 4,
  },
  ctaRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
  },
  // Small, quiet outlined pill — content-width (not full width), rounded, neutral border.
  cta: {
    fontSize: 12,
    fontWeight: '600',
    color: '#1C1917',
    minWidth: 72,
    textAlign: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#E5E3DC',
    overflow: 'hidden',
  },
  lineSkeletonWide: {
    height: 12, borderRadius: 3, backgroundColor: '#E0DED7', width: '85%',
  },
  lineSkeletonNarrow: {
    height: 12, borderRadius: 3, backgroundColor: '#E0DED7', marginTop: 8, width: '50%',
  },
});
