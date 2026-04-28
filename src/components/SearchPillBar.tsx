/**
 * SearchPillBar — shared search bar pill used by Home and Discover.
 *
 * Encapsulates: container (height, radius, margins, border, bg),
 * left search icon, and center divider. Caller supplies:
 *   - children: center content (Text placeholder on Home, TextInput on Discover)
 *   - rightSlot: right icon area (camera on Home, filter on Discover)
 *   - onPress: makes the whole pill tappable (Home navigates to Search)
 */

import React from 'react';
import { View, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

type Props = {
  children: React.ReactNode;
  rightSlot: React.ReactNode;
  onPress?: () => void;
};

export default function SearchPillBar({ children, rightSlot, onPress }: Props) {
  if (onPress) {
    return (
      <TouchableOpacity style={styles.pill} activeOpacity={0.9} onPress={onPress}>
        <Ionicons name="search-outline" size={18} color="#6B7280" />
        {children}
        <View style={styles.divider} />
        {rightSlot}
      </TouchableOpacity>
    );
  }
  return (
    <View style={styles.pill}>
      <Ionicons name="search-outline" size={18} color="#6B7280" />
      {children}
      <View style={styles.divider} />
      {rightSlot}
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 999,
    height: 44,
    paddingLeft: 14,
    paddingRight: 8,
    marginHorizontal: 16,
    marginTop: 8,
    marginBottom: 4,
    gap: 8,
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.07)',
  },
  divider: {
    width: 1,
    height: 18,
    backgroundColor: '#E5E7EB',
  },
});
