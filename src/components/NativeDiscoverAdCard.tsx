/**
 * NativeDiscoverAdCard — ONE quiet, compact, full-width horizontal Native Advanced
 * card rendered inline in the Discover feed. It should read almost like a
 * recommendation card, never a large advertisement (never popup/overlay/modal/
 * full-screen).
 *
 *   ┌───────────────────────────────────────────────┐
 *   │ Ad                                       (ⓘ)  │  header 18 — AdChoices top-right
 *   │ ┌────────┐  Headline (≤2 lines)                │
 *   │ │ 78×76  │  Advertiser (≤1)            [ CTA ] │  body row 76 (fixed)
 *   │ └────────┘                                     │
 *   └───────────────────────────────────────────────┘   total ~116 pt (hard max 124)
 *
 * Compliance (Google Native / react-native-google-mobile-ads):
 *   - Every rendered asset is a child of a single <NativeAdView>.
 *   - Media via <NativeMediaView> (registered) in a FIXED 78×76 clipped container,
 *     so it can NEVER control/grow the card height; resizeMode="contain" so video is
 *     contained (no stretch, no player controls overlapping text).
 *   - Headline / advertiser / CTA each wrapped in <NativeAsset> with the correct
 *     assetType; CTA is a plain <Text> (no Touchable / no custom onPress) so the SDK
 *     handles the click — nothing intercepts it.
 *   - "Ad" attribution top-left (11pt, medium, visible). Top-right kept clear AND the
 *     card does NOT use overflow:hidden, so the SDK-placed AdChoices overlay is never
 *     clipped. Only the inner media container clips (its own overflow:hidden).
 *   - No body text. No overlapping asset views. Creatives missing a headline are
 *     skipped (null) so the product feed is preserved.
 *
 * NOTE: the exact on-device AdMob Native Validator messages could not be retrieved
 * in this build environment; the above are the SDK-documented correctness rules.
 *
 * Lifecycle: async load (never blocks Discover/startup); small skeleton while
 * loading; NO_FILL/error → null (collapses); NativeAd destroyed on unmount; loads
 * once per mount; dev-only logs; no service-role credentials.
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

const MEDIA_WIDTH = 78;   // 76–80 pt
const MEDIA_HEIGHT = 76;  // 72–80 pt — fixed; media never drives card height
const BODY_ROW_HEIGHT = 76;

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

  // Loading → small skeleton mirroring the final height (no oversized blank, no jump).
  if (status === 'loading' || !nativeAd) {
    return (
      <View style={styles.card}>
        <View style={styles.header}><Text style={styles.adLabel}>Ad</Text></View>
        <View style={styles.bodyRow}>
          <View style={[styles.mediaContainer, styles.skeleton]} />
          <View style={styles.textCol}>
            <View style={styles.lineSkeletonWide} />
            <View style={styles.lineSkeletonNarrow} />
          </View>
        </View>
      </View>
    );
  }

  // Skip a creative that cannot be shown correctly in the compact layout.
  if (!nativeAd.headline) return null;

  return (
    <View style={styles.card}>
      <NativeAdView nativeAd={nativeAd} style={styles.adView}>
        {/* "Ad" attribution top-left; top-right kept clear for the SDK AdChoices overlay. */}
        <View style={styles.header}><Text style={styles.adLabel}>Ad</Text></View>

        <View style={styles.bodyRow}>
          {/* Media in a FIXED, clipped container — cannot control/grow the card. */}
          <View style={styles.mediaContainer}>
            <NativeMediaView style={styles.media} resizeMode="contain" />
          </View>

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
                  {/* Exact SDK callToAction text — small quiet outlined pill, NOT the gold
                      Add-to-Cart button; plain <Text> so the SDK click handler is not intercepted. */}
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
  // Full-width inline card aligned with the Discover grid. Matches product-card
  // radius/border/background; no heavy shadow. Fixed height = 8 + 18 + 6 + 76 + 8 = 116 pt.
  // NOTE: intentionally NO overflow:'hidden' here so the SDK AdChoices overlay (top-right)
  // is never clipped; only the media container clips its own content.
  card: {
    marginHorizontal: 3,
    marginVertical: 6,
    borderRadius: 6,
    backgroundColor: '#FFFFFF',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#E5E3DC',
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
  adLabel: {
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.4,
    color: '#78716C', // subtle gray, medium weight — clearly visible, not dominant
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
    overflow: 'hidden', // clip media only (not the whole card / AdChoices)
    backgroundColor: '#ECEAE2',
  },
  media: { width: '100%', height: '100%' },
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
    color: '#1C1917', // matches product-title text color
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
  // Small, quiet outlined pill — not full-width, not gold, subordinate to product content.
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
