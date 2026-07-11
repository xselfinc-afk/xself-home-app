/**
 * NativeDiscoverAdCard — a single full-width Native Advanced ad rendered inline
 * inside the Discover feed (never a popup / overlay / modal / full-screen).
 *
 * Lifecycle (memory-safe):
 *   - Loads asynchronously via NativeAd.createForAdRequest (never blocks Discover).
 *   - status 'loading' → a neutral fixed-height placeholder (reserves space to
 *     minimize layout jump).
 *   - status 'loaded'  → the ad, wrapped in <NativeAdView> with registered assets.
 *   - status 'failed'/NO_FILL → renders null (collapses; products flow normally).
 *   - Destroys the NativeAd on unmount (and if it resolves after unmount).
 *   - Loads once per mount (effect keyed on the resolved unit id) — no reload on
 *     re-render; stable feed keys keep this row mounted across list re-renders.
 *
 * Only assets actually returned by the ad are shown. No invented price / rating /
 * shipping / stock / discount, no cart icon, no Add-to-Cart-looking CTA.
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

  // Loading → neutral reserved placeholder (approx the loaded height) to limit jump.
  if (status === 'loading' || !nativeAd) {
    return (
      <View style={[styles.card, styles.placeholder]}>
        <Text style={styles.sponsored}>SPONSORED</Text>
        <View style={styles.mediaSkeleton} />
        <View style={styles.lineSkeletonWide} />
        <View style={styles.lineSkeletonNarrow} />
      </View>
    );
  }

  return (
    <View style={styles.card}>
      <NativeAdView nativeAd={nativeAd} style={styles.adView}>
        {/* Attribution — required. AdChoices overlay is added by NativeAdView; the
            top-right corner is left clear so it is never covered. */}
        <Text style={styles.sponsored}>SPONSORED</Text>

        <NativeMediaView style={styles.media} resizeMode="cover" />

        <View style={styles.textBlock}>
          <NativeAsset assetType={NativeAssetType.HEADLINE}>
            <Text style={styles.headline} numberOfLines={2}>{nativeAd.headline}</Text>
          </NativeAsset>

          {nativeAd.advertiser ? (
            <NativeAsset assetType={NativeAssetType.ADVERTISER}>
              <Text style={styles.advertiser} numberOfLines={1}>{nativeAd.advertiser}</Text>
            </NativeAsset>
          ) : null}

          {nativeAd.body ? (
            <NativeAsset assetType={NativeAssetType.BODY}>
              <Text style={styles.body} numberOfLines={2}>{nativeAd.body}</Text>
            </NativeAsset>
          ) : null}

          {nativeAd.callToAction ? (
            <View style={styles.ctaRow}>
              <NativeAsset assetType={NativeAssetType.CALL_TO_ACTION}>
                <Text style={styles.cta}>{nativeAd.callToAction}</Text>
              </NativeAsset>
            </View>
          ) : null}
        </View>
      </NativeAdView>
    </View>
  );
}

const styles = StyleSheet.create({
  // Full-width inline card — aligns with the Discover grid's outer edges
  // (grid gridItem margin is 3 inside feed paddingHorizontal 8). Neutral, restrained.
  card: {
    marginHorizontal: 3,
    marginVertical: 6,
    borderRadius: 6,
    backgroundColor: '#FFFFFF',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#E5E3DC',
    overflow: 'hidden',
    // Reserved height to minimize layout jump between loading and loaded states.
    minHeight: 300,
  },
  placeholder: {
    backgroundColor: '#ECEAE2',
    padding: 12,
  },
  adView: {
    width: '100%',
    padding: 12,
  },
  sponsored: {
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 0.6,
    color: '#9CA3AF',
    marginBottom: 8,
  },
  media: {
    width: '100%',
    aspectRatio: 1.91, // wide landscape inline media
    borderRadius: 4,
    backgroundColor: '#E5E3DC',
  },
  mediaSkeleton: {
    width: '100%',
    aspectRatio: 1.91,
    borderRadius: 4,
    backgroundColor: '#E0DED7',
  },
  textBlock: {
    marginTop: 10,
  },
  headline: {
    fontSize: 15,
    fontWeight: '600',
    color: '#1C1917',
  },
  advertiser: {
    fontSize: 12,
    color: '#78716C',
    marginTop: 2,
  },
  body: {
    fontSize: 13,
    color: '#57534E',
    marginTop: 4,
  },
  ctaRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: 10,
  },
  // Restrained, right-aligned outlined text — deliberately NOT the gold Add-to-Cart pill.
  cta: {
    fontSize: 13,
    fontWeight: '600',
    color: '#1C1917',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#E5E3DC',
    overflow: 'hidden',
  },
  lineSkeletonWide: {
    height: 12,
    borderRadius: 3,
    backgroundColor: '#E0DED7',
    marginTop: 12,
    width: '75%',
  },
  lineSkeletonNarrow: {
    height: 12,
    borderRadius: 3,
    backgroundColor: '#E0DED7',
    marginTop: 8,
    width: '45%',
  },
});
