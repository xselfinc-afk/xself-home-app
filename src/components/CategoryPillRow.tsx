import React from 'react';
import { ScrollView, TouchableOpacity, Text, StyleSheet } from 'react-native';

// ── Shared spacing / sizing tokens ───────────────────────────────────────────
// Discover is the canonical standard; Home must match these values exactly.
export const CATEGORY_ROW_TOKENS = {
  /** paddingVertical on the ScrollView container */
  rowPaddingVertical: 8,
  /** horizontal padding inside the scroll content */
  rowContentPaddingHorizontal: 10,
  /** gap between adjacent pills */
  pillGap: 6,
  /** horizontal padding inside each pill */
  pillPaddingHorizontal: 14,
  /** vertical padding inside each pill */
  pillPaddingVertical: 7,
  pillBorderRadius: 999,
  pillFontSize: 13,
};

interface Props {
  categories: string[];
  isActive: (cat: string) => boolean;
  onPress: (cat: string) => void;
}

export function CategoryPillRow({ categories, isActive, onPress }: Props) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.row}
      contentContainerStyle={styles.rowContent}
    >
      {categories.map(cat => {
        const active = isActive(cat);
        return (
          <TouchableOpacity
            key={cat}
            style={[styles.pill, active && styles.pillActive]}
            onPress={() => onPress(cat)}
          >
            <Text style={[styles.pillText, active && styles.pillTextActive]}>
              {cat}
            </Text>
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
}

const { rowPaddingVertical, rowContentPaddingHorizontal, pillGap,
        pillPaddingHorizontal, pillPaddingVertical, pillBorderRadius, pillFontSize } = CATEGORY_ROW_TOKENS;

const styles = StyleSheet.create({
  row: { paddingVertical: rowPaddingVertical },
  rowContent: { paddingHorizontal: rowContentPaddingHorizontal, gap: pillGap },
  pill: {
    paddingHorizontal: pillPaddingHorizontal,
    paddingVertical: pillPaddingVertical,
    borderRadius: pillBorderRadius,
    backgroundColor: '#F3F4F6',
    borderWidth: 1,
    borderColor: 'transparent',
  },
  pillActive: { backgroundColor: '#FFFBF0', borderColor: '#EAB320' },
  pillText: { fontSize: pillFontSize, color: '#6B7280', fontWeight: '500' },
  pillTextActive: { color: '#92660A', fontWeight: '600' },
});
