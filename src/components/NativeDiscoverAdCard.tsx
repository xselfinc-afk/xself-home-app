/**
 * NativeDiscoverAdCard — a single full-width Native Advanced ad rendered inline
 * inside the Discover feed (never a popup / overlay / modal / full-screen).
 *
 * Layout (deterministic height ~285–320 pt):
 *   header (Sponsored, ~18) → FIXED-height media box (172) → headline (≤2 lines)
 *   → optional body (≤2 lines) → advertiser + CTA row. The media lives in its own
 *   fixed-height, overflow-clipped container so it can NEVER determine the card
 *   height or overlap the text below it.
 *
 * Media sizing: NativeMediaView fills the fixed 172-pt container with
 * resizeMode="cover". iOS maps resizeMode → GADMediaView contentMode
 * (cover→scaleAspectFill, contain→scaleAspectFit, stretch→scaleToFill). Image
 * assets scale-and-crop to fill; video is rendered by GADMediaView honoring its
 * own aspect (may letterbox within the box) — either way the media is clipped to
 * the fixed container, so no assumption is made that video is cropped.
 *
 * Lifecycle (memory-safe):
 *   - Loads asynchronously via NativeAd.createForAdRequest (never blocks Discover).
 *   - 'loading' → compact skeleton matching the final card size (no oversized blank).
 *   - 'loaded'  → the ad, wrapped in <NativeAdView> with registered assets.
 *   - 'failed'/NO_FILL → renders null (collapses; products flow normally).
 *   - Destroys the NativeAd on unmount (and if it resolves after unmount).
 *   - Loads once per mount (effect keyed on the resolved unit id).
 *
 * Only assets the ad returns are shown. No invented price / rating / shipping /
 * stock / discount, no cart icon, no Add-to-Cart-looking CTA.
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

const MEDIA_HEIGHT = 172; // fixed — the media never drives the card height

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

  // Loading → compact skeleton that mirrors the final layout/height (no jump on load).
  if (status === 'loading' || !nativeAd) {
    return (
      <View style={styles.card}>
        <View style={styles.header}>
          <Text style={styles.sponsored}>Sponsored</Text>
        </View>
        <View style={[styles.mediaContainer, styles.mediaSkeleton]} />
        <View style={styles.textBlock}>
          <View style={styles.lineSkeletonWide} />
          <View style={styles.lineSkeletonNarrow} />
        </View>
      </View>
    );
  }

  return (
    <View style={styles.card}>
      <NativeAdView nativeAd={nativeAd} style={styles.adView}>
        {/* Header: "Sponsored" top-left; top-right left clear for the SDK's
            AdChoices overlay so it is never covered. */}
        <View style={styles.header}>
          <Text style={styles.sponsored}>Sponsored</Text>
        </View>

        {/* Media in its own FIXED-height, clipped container — cannot expand the
            card or overlap the text below. */}
        <View style={styles.mediaContainer}>
          <NativeMediaView style={styles.media} resizeMode="cover" />
        </View>

        <View style={styles.textBlock}>
          <NativeAsset assetType={NativeAssetType.HEADLINE}>
            <Text style={styles.headline} numberOfLines={2}>{nativeAd.headline}</Text>
          </NativeAsset>

          {nativeAd.body ? (
            <NativeAsset assetType={NativeAssetType.BODY}>
              <Text style={styles.body} numberOfLines={2}>{nativeAd.body}</Text>
            </NativeAsset>
          ) : null}

          <View style={styles.metaRow}>
            {nativeAd.advertiser ? (
              <NativeAsset assetType={NativeAssetType.ADVERTISER}>
                <Text style={styles.advertiser} numberOfLines={1}>{nativeAd.advertiser}</Text>
              </NativeAsset>
            ) : (
              <View style={styles.metaSpacer} />
            )}

            {nativeAd.callToAction ? (
              <NativeAsset assetType={NativeAssetType.CALL_TO_ACTION}>
                {/* Exact SDK callToAction text (e.g. INSTALL / SHOP NOW) — restrained
                    outlined pill, deliberately NOT the gold Add-to-Cart button. */}
                <Text style={styles.cta} numberOfLines={1}>{nativeAd.callToAction}</Text>
              </NativeAsset>
            ) : null}
          </View>
        </View>
      </NativeAdView>
    </View>
  );
}

const styles = StyleSheet.create({
  // Full-width inline card — aligns with the Discover grid's outer edges
  // (grid gridItem margin is 3 inside feed paddingHorizontal 8). Height is
  // content-driven but bounded (fixed media + capped text lines) → ~285–320 pt.
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
    marginBottom: 4,
  },
  sponsored: {
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.4,
    color: '#9CA3AF',
  },
  mediaContainer: {
    width: '100%',
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
  textBlock: {
    marginTop: 8,
  },
  headline: {
    fontSize: 14,
    lineHeight: 17,
    fontWeight: '600',
    color: '#1C1917',
  },
  body: {
    fontSize: 12,
    lineHeight: 15,
    color: '#57534E',
    marginTop: 2,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 6,
  },
  metaSpacer: {
    flex: 1,
  },
  advertiser: {
    fontSize: 12,
    color: '#78716C',
    flexShrink: 1,
    marginRight: 8,
  },
  // Small restrained outlined pill — not gold, not full-width, not visually dominant.
  cta: {
    fontSize: 12,
    fontWeight: '600',
    color: '#1C1917',
    paddingHorizontal: 10,
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
    marginTop: 4,
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
