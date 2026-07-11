/**
 * NativeDiscoverAdCard — a single full-width, COMPACT Native Advanced "sponsor
 * strip" rendered inline in the Discover feed (never popup/overlay/modal/full-screen).
 *
 * Two reusable, policy-safe modes (selected by AD_CARD_MODE):
 *
 *   MICRO_MEDIA_COMPACT (default) — media 88×72 on the left, text on the right:
 *     ┌───────────────────────────────────────────┐
 *     │ Sponsored                             (ⓘ) │  header 18 (AdChoices top-right)
 *     │ ┌────────┐  Headline (≤2)                  │
 *     │ │ 88×72  │  Advertiser (≤1)      [ CTA ]   │  body row 76 (fixed)
 *     │ └────────┘                                 │
 *     └───────────────────────────────────────────┘   total ~116 pt (hard max 124)
 *
 *   ICON_ONLY_COMPACT — 62×62 icon on the left, no media (total ~112 pt).
 *
 * Why MICRO_MEDIA is the default: ICON_ONLY may only be used if the on-device
 * Native Validator passes with NativeMediaView omitted — that precondition cannot
 * be verified in this build environment, and Native Advanced generally expects a
 * registered MediaView, so the media-present mode is the compliance-safe default.
 * Flip AD_CARD_MODE to switch once the device validator confirms icon-only passes.
 *
 * Compliance: every rendered asset is a child of a single <NativeAdView>; media via
 * <NativeMediaView> (registered) in a FIXED clipped container that can never grow
 * the card; headline / advertiser / icon / CTA each wrapped in <NativeAsset> with
 * the correct assetType; CTA shows the exact SDK text as a plain registered <Text>
 * (no Touchable wrapper that could intercept the SDK click); AdChoices top-right is
 * kept clear; no overlapping asset views; no body text. If a creative can't be shown
 * in the compact layout (e.g. ICON_ONLY with no icon), the ad is skipped (null) and
 * the product feed is preserved.
 *
 * Lifecycle: async load (never blocks Discover/startup); compact skeleton while
 * loading; NO_FILL/error → null (collapses); NativeAd destroyed on unmount; loads
 * once per mount; dev-only logs; no service-role credentials.
 */

import React, { useEffect, useRef, useState } from 'react';
import { View, Text, Image, StyleSheet } from 'react-native';
import {
  NativeAd,
  NativeAdView,
  NativeMediaView,
  NativeAsset,
  NativeAssetType,
} from 'react-native-google-mobile-ads';
import { resolveNativeAdUnitId } from '../config/ads';

// Preferred is ICON_ONLY_COMPACT, but it may only be used once the on-device
// Native Validator confirms it passes without a MediaView. Default to the
// compliance-safe media-present mode until then.
const AD_CARD_MODE: 'ICON_ONLY_COMPACT' | 'MICRO_MEDIA_COMPACT' = 'MICRO_MEDIA_COMPACT';

const MEDIA_WIDTH = 88;
const MEDIA_HEIGHT = 72;
const ICON_SIZE = 62;
const BODY_ROW_HEIGHT = AD_CARD_MODE === 'MICRO_MEDIA_COMPACT' ? 76 : 72;

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
      <View style={styles.card}>
        <View style={styles.header}><Text style={styles.sponsored}>Sponsored</Text></View>
        <View style={styles.bodyRow}>
          <View style={[AD_CARD_MODE === 'MICRO_MEDIA_COMPACT' ? styles.mediaContainer : styles.iconBox, styles.skeleton]} />
          <View style={styles.textCol}>
            <View style={styles.lineSkeletonWide} />
            <View style={styles.lineSkeletonNarrow} />
          </View>
        </View>
      </View>
    );
  }

  // Skip a creative that can't be shown correctly in the compact layout.
  if (!nativeAd.headline) return null;
  if (AD_CARD_MODE === 'ICON_ONLY_COMPACT' && !nativeAd.icon?.url) return null;

  return (
    <View style={styles.card}>
      <NativeAdView nativeAd={nativeAd} style={styles.adView}>
        {/* Header: "Sponsored" top-left; top-right kept clear for SDK AdChoices. */}
        <View style={styles.header}><Text style={styles.sponsored}>Sponsored</Text></View>

        <View style={styles.bodyRow}>
          {AD_CARD_MODE === 'MICRO_MEDIA_COMPACT' ? (
            // Media in a FIXED clipped container — cannot control/grow the card.
            <View style={styles.mediaContainer}>
              <NativeMediaView style={styles.media} resizeMode="cover" />
            </View>
          ) : nativeAd.icon?.url ? (
            <NativeAsset assetType={NativeAssetType.ICON}>
              <Image source={{ uri: nativeAd.icon.url }} style={styles.iconBox} resizeMode="cover" />
            </NativeAsset>
          ) : null}

          <View style={styles.textCol}>
            <NativeAsset assetType={NativeAssetType.HEADLINE}>
              <Text style={styles.headline} numberOfLines={2}>{nativeAd.headline}</Text>
            </NativeAsset>

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
                  {/* Exact SDK callToAction text — restrained outlined pill, NOT gold Add-to-Cart,
                      plain <Text> (no Touchable) so the SDK click handler is not intercepted. */}
                  <Text style={styles.cta} numberOfLines={1}>{nativeAd.callToAction}</Text>
                </NativeAsset>
              ) : null}
            </View>
          </View>
        </View>
      </NativeAdView>
    </View>
  );
}

const styles = StyleSheet.create({
  // Full-width inline card aligned with the Discover grid's outer edges. No heavy
  // shadow. Fixed height = 8 + 18 + 6 + BODY_ROW_HEIGHT + 8 (~112–116 pt).
  card: {
    marginHorizontal: 3,
    marginVertical: 6,
    borderRadius: 6,
    backgroundColor: '#FFFFFF',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#E5E3DC',
    overflow: 'hidden',
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 8,
  },
  adView: { width: '100%' },
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
    color: '#78716C', // medium contrast — clearly visible, not nearly invisible
  },
  bodyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    height: BODY_ROW_HEIGHT, // fixed → deterministic card height
  },
  mediaContainer: {
    width: MEDIA_WIDTH,
    height: MEDIA_HEIGHT,
    borderRadius: 4,
    overflow: 'hidden',
    backgroundColor: '#E5E3DC',
  },
  media: { width: '100%', height: '100%' },
  iconBox: {
    width: ICON_SIZE,
    height: ICON_SIZE,
    borderRadius: 8,
    backgroundColor: '#E5E3DC',
  },
  skeleton: { backgroundColor: '#E0DED7' },
  textCol: {
    flex: 1,
    marginLeft: 12,
    height: BODY_ROW_HEIGHT,
    justifyContent: 'space-between',
    paddingVertical: 2,
  },
  headline: {
    fontSize: 13,
    lineHeight: 17,
    fontWeight: '600',
    color: '#1C1917',
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  metaSpacer: { flex: 1 },
  advertiser: {
    fontSize: 12,
    color: '#78716C',
    flexShrink: 1,
    marginRight: 8,
  },
  // Small restrained outlined pill — not full-width, not gold, subordinate to products.
  cta: {
    fontSize: 12,
    fontWeight: '600',
    color: '#1C1917',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
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
