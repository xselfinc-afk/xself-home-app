/**
 * HomeShopYourWay (Phase 2.5) — Experience-led, intent-based discovery for Home.
 *
 * A segmented module with three lenses — Shop by room / Shop by product / Shop by
 * need — each backed by pure `buildShopYourWay()` mappings onto EXISTING routes
 * (CommerceResults / Collection). It is deliberately DISTINCT from the taxonomy
 * "Shop by department" rail: it leads with intent (rooms, product types, curated
 * needs), uses image-overlay editorial cards, and never duplicates the department
 * shortcuts or the All Categories database view.
 *
 * Selected lens is local state and persists while the user stays on Home (the module
 * stays mounted in the list header). Content is a single HORIZONTAL rail — it never
 * introduces a competing vertical scroll. Rail height is reserved so late catalog
 * loading does not shift the modules below.
 *
 * "Need" has no dedicated production taxonomy; it surfaces the approved Collections
 * subset (see src/services/shopYourWay.ts) — reported as a known limitation.
 */
import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { variantUrl } from '../../utils/imageVariant';
import { loadSellableProducts } from '../../services/commerceCatalogLoader';
import { buildCommerceCatalog } from '../../services/commerceCatalog';
import { buildShopYourWay, type ShopYourWayContent, type SywEntry, type SywMode } from '../../services/shopYourWay';

const INK = '#1C1917', GOLD_DARK = '#CA8A04', SECONDARY = '#6B7280', MUTED = '#9CA3AF', LINE = 'rgba(28,25,23,0.10)', WARM = '#ECE7DE';
const RAIL_H = 116; // reserved so cards appearing after catalog load do not shift layout

const MODES: { key: SywMode; label: string }[] = [
  { key: 'room', label: 'Shop by room' },
  { key: 'product', label: 'Shop by product' },
  { key: 'need', label: 'Shop by need' },
];

function MediaCard({ entry, onPress, width }: { entry: SywEntry; onPress: () => void; width: number }) {
  const [failed, setFailed] = useState(false);
  const showImage = !!entry.image && !failed;
  return (
    <TouchableOpacity style={[styles.card, { width }]} activeOpacity={0.85} onPress={onPress}>
      {showImage ? (
        <Image
          source={{ uri: variantUrl(entry.image as string, { width: 400 }) }}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          cachePolicy="memory-disk"
          transition={140}
          onError={() => setFailed(true)}
        />
      ) : (
        <View style={styles.cardFallback}><Ionicons name="cube-outline" size={26} color="#B8AE9C" /></View>
      )}
      <View style={styles.cardScrim} />
      <View style={styles.cardBody}>
        <Text style={styles.cardLabel} numberOfLines={2}>{entry.label}</Text>
        {entry.count != null ? <Text style={styles.cardMeta}>{entry.count} items</Text> : null}
      </View>
    </TouchableOpacity>
  );
}

function NeedCard({ entry, onPress }: { entry: SywEntry; onPress: () => void }) {
  return (
    <TouchableOpacity style={styles.needCard} activeOpacity={0.85} onPress={onPress}>
      <Text style={styles.needKicker}>COLLECTION</Text>
      <Text style={styles.needLabel} numberOfLines={2}>{entry.label}</Text>
      {entry.sub ? <Text style={styles.needSub} numberOfLines={2}>{entry.sub}</Text> : null}
    </TouchableOpacity>
  );
}

export default function HomeShopYourWay({ navigation }: { navigation: any }) {
  const [content, setContent] = useState<ShopYourWayContent | null>(null);
  const [mode, setMode] = useState<SywMode>('room');

  useEffect(() => {
    let a = true;
    loadSellableProducts().then(p => { if (a) setContent(buildShopYourWay(buildCommerceCatalog(p))); });
    return () => { a = false; };
  }, []);

  const entries: SywEntry[] = content ? content[mode] : [];
  const go = (e: SywEntry) => navigation.navigate(e.route.screen, e.route.params as any);

  return (
    <View style={styles.wrap}>
      <View style={styles.header}>
        <Text style={styles.title}>Shop your way</Text>
      </View>

      {/* Lens pills — horizontally scrollable so every mode stays fully readable and
          tappable on narrow screens (no clipping); active dark/filled, inactive
          light/outlined. 44pt tap targets. First/last pills keep 16pt edge padding. */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.pills}
        style={styles.pillsScroll}
      >
        {MODES.map(m => {
          const on = m.key === mode;
          return (
            <TouchableOpacity
              key={m.key}
              style={[styles.pill, on ? styles.pillOn : styles.pillOff]}
              activeOpacity={0.8}
              hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
              onPress={() => setMode(m.key)}
            >
              <Text style={[styles.pillText, on ? styles.pillTextOn : styles.pillTextOff]}>{m.label}</Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {/* Single horizontal content rail; height reserved to prevent layout shift.
          While the catalog is still loading (content === null) show skeleton cards
          instead of a blank rail, so the module never appears empty on a cold start.
          Warm in-memory cache resolves in a tick, so this is a brief placeholder. */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.rail} style={{ minHeight: RAIL_H }}>
        {content === null
          ? [0, 1, 2].map(i => <View key={`sk-${i}`} style={styles.skeletonCard} />)
          : mode === 'need'
            ? entries.map(e => <NeedCard key={e.id} entry={e} onPress={() => go(e)} />)
            : entries.map(e => <MediaCard key={e.id} entry={e} onPress={() => go(e)} width={156} />)}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingBottom: 4 },
  header: { paddingHorizontal: 16, paddingTop: 22, paddingBottom: 10 },
  title: { fontSize: 15, fontWeight: '700', color: INK, letterSpacing: -0.1 },
  pillsScroll: { flexGrow: 0 },
  pills: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingRight: 20, paddingBottom: 12 },
  pill: { height: 38, paddingHorizontal: 16, borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
  pillOn: { backgroundColor: INK },
  pillOff: { backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: LINE },
  pillText: { fontSize: 13, fontWeight: '600' },
  pillTextOn: { color: '#FFFFFF' },
  pillTextOff: { color: INK },
  rail: { paddingHorizontal: 16, paddingRight: 24, gap: 12 },
  card: { height: RAIL_H - 12, borderRadius: 16, overflow: 'hidden', backgroundColor: WARM, justifyContent: 'flex-end' },
  skeletonCard: { width: 156, height: RAIL_H - 12, borderRadius: 16, backgroundColor: WARM },
  cardFallback: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', backgroundColor: WARM },
  cardScrim: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(28,25,23,0.32)' },
  cardBody: { padding: 12 },
  cardLabel: { fontSize: 14, fontWeight: '700', color: '#FFFFFF', letterSpacing: -0.1 },
  cardMeta: { fontSize: 11, color: 'rgba(255,255,255,0.9)', marginTop: 2 },
  needCard: { width: 210, height: RAIL_H - 12, borderRadius: 16, backgroundColor: INK, padding: 14, justifyContent: 'center' },
  needKicker: { fontSize: 10, fontWeight: '700', letterSpacing: 1, color: GOLD_DARK, marginBottom: 6 },
  needLabel: { fontSize: 16, fontWeight: '700', color: '#FFFFFF', letterSpacing: -0.2 },
  needSub: { fontSize: 12, color: 'rgba(255,255,255,0.78)', marginTop: 3, lineHeight: 16 },
});
