/**
 * ConciergeTopBanner — presentational in-app top banner for a new Xself
 * Concierge (support) message.
 *
 * PURE UI. This component intentionally contains NO business logic:
 *   • No navigation (parent passes onPress).
 *   • No Crisp / message polling (parent passes title/preview).
 *   • No AsyncStorage, no unread bookkeeping.
 *   • No quote / offer / cart / checkout / payment / order logic.
 *
 * Auto-dismiss is deliberately NOT handled here — the parent owns the timer so
 * dismissal can be coordinated with app state, navigation, and the unread/
 * mark-read source of truth (ConciergeContext). Keeping the timer out of this
 * pure component avoids duplicated/conflicting dismiss logic and keeps it
 * trivially testable. The component only animates in/out based on `visible`.
 */

import React, { useEffect, useRef } from 'react';
import { Animated, Text, TouchableOpacity, View, StyleSheet, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

// Xself warm palette (DESIGN.md): gold accent, warm neutrals — never pure black/blue.
const XSELF_GOLD = '#CA8A04';
const INK        = '#1d1d1f';
const MUTED      = '#6b675c';

export interface ConciergeTopBannerProps {
  /** When true, the banner animates in; when false, it animates out. */
  visible: boolean;
  /** Optional one-line message preview shown under the title. */
  preview?: string | null;
  /** Title text. Defaults to the standard Concierge alert copy. */
  title?: string;
  /** Tap handler (parent navigates to Support + marks read). */
  onPress: () => void;
  /** Dismiss handler (parent clears the banner; e.g. close button / swipe-less tap-away). */
  onDismiss: () => void;
}

export default function ConciergeTopBanner({
  visible,
  preview,
  title = 'New message from Xself Concierge',
  onPress,
  onDismiss,
}: ConciergeTopBannerProps) {
  const insets = useSafeAreaInsets();
  const anim = useRef(new Animated.Value(0)).current; // 0 = hidden (above), 1 = shown

  useEffect(() => {
    Animated.timing(anim, {
      toValue: visible ? 1 : 0,
      duration: visible ? 240 : 180,
      useNativeDriver: true,
    }).start();
  }, [visible, anim]);

  const translateY = anim.interpolate({ inputRange: [0, 1], outputRange: [-120, 0] });

  // Keep mounted while animating; parent controls `visible`. pointerEvents off
  // when hidden so it never blocks touches on the screen below.
  return (
    <Animated.View
      pointerEvents={visible ? 'box-none' : 'none'}
      style={[
        styles.wrap,
        { paddingTop: insets.top + 8, opacity: anim, transform: [{ translateY }] },
      ]}
    >
      <TouchableOpacity
        activeOpacity={0.9}
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={title}
        style={styles.card}
      >
        {/* Concierge mark */}
        <View style={styles.iconWrap}>
          <Ionicons name="chatbubbles" size={18} color={XSELF_GOLD} />
        </View>

        {/* Title + preview */}
        <View style={styles.textWrap}>
          <Text style={styles.title} numberOfLines={1}>{title}</Text>
          {!!preview && (
            <Text style={styles.preview} numberOfLines={1}>{preview}</Text>
          )}
        </View>

        {/* Tap affordance */}
        <Ionicons name="chevron-forward" size={18} color={MUTED} style={styles.chevron} />

        {/* Dismiss */}
        <TouchableOpacity
          onPress={onDismiss}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          accessibilityRole="button"
          accessibilityLabel="Dismiss notification"
          style={styles.closeBtn}
        >
          <Ionicons name="close" size={16} color={MUTED} />
        </TouchableOpacity>
      </TouchableOpacity>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 1000,
    paddingHorizontal: 12,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#ECE7DA',
    paddingVertical: 12,
    paddingHorizontal: 14,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOpacity: 0.12,
        shadowRadius: 16,
        shadowOffset: { width: 0, height: 6 },
      },
      android: { elevation: 6 },
    }),
  },
  iconWrap: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: '#FBF4DD', // soft gold tint
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  textWrap: { flex: 1, minWidth: 0 },
  title: { fontSize: 14, fontWeight: '700', color: INK },
  preview: { fontSize: 13, color: MUTED, marginTop: 2 },
  chevron: { marginLeft: 8 },
  closeBtn: { marginLeft: 6, padding: 2 },
});
