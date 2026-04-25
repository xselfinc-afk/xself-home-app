/**
 * Reusable Home Hero Banner component.
 *
 * Supports three layout variants:
 *   TEXT_LEFT   — text on left ~46%, image supports the right side (default)
 *   CENTER_STACK — centered text, full image background with overlay
 *   CARD_OVERLAY — full image background, floating card bottom-left
 *
 * Designed for furniture e-commerce: text-first, conversion-focused,
 * image-driven but not image-dominated.
 */

import React, { useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  Image,
  StyleSheet,
  Dimensions,
  Animated,
  Pressable,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';

export type HeroVariant = 'TEXT_LEFT' | 'CENTER_STACK' | 'CARD_OVERLAY';

export interface HeroBannerProps {
  variant?: HeroVariant;
  title: string;
  subtitle?: string;
  ctaText?: string;
  /** Product or lifestyle image URL. Falls back to warm gradient when null/undefined. */
  image?: string | null;
  /**
   * Recommended image position for TEXT_LEFT layout.
   *   'right'  — image container starts at 25% from left, leaving text zone clean (default for lifestyle shots)
   *   'center' — image fills full banner behind gradient (good for centered compositions)
   *   'left'   — image container ends at 75% from left (less common)
   */
  imagePosition?: 'left' | 'center' | 'right';
  /**
   * When true, renders a blurred low-opacity copy of the image as a background
   * layer before the sharp foreground image. Creates a soft, premium look.
   */
  useSoftBlur?: boolean;
  onPress?: () => void;
  /** Banner height = screenWidth × heightRatio. Default 0.75. */
  heightRatio?: number;
}

const { width: SCREEN_WIDTH } = Dimensions.get('window');

const TEXT_SHADOW = {
  textShadowColor: 'rgba(0,0,0,0.20)',
  textShadowOffset: { width: 0, height: 1 },
  textShadowRadius: 5,
} as const;

export function HeroBanner({
  variant = 'TEXT_LEFT',
  title,
  subtitle,
  ctaText,
  image,
  imagePosition = 'right',
  useSoftBlur = false,
  onPress,
  heightRatio = 0.58,
}: HeroBannerProps) {
  const bannerHeight = Math.round(SCREEN_WIDTH * heightRatio);
  const scaleAnim = useRef(new Animated.Value(1)).current;

  function handlePressIn() {
    Animated.timing(scaleAnim, {
      toValue: 0.975,
      duration: 100,
      useNativeDriver: true,
    }).start();
  }

  function handlePressOut() {
    Animated.timing(scaleAnim, {
      toValue: 1,
      duration: 140,
      useNativeDriver: true,
    }).start();
  }

  return (
    <Pressable onPress={onPress} onPressIn={handlePressIn} onPressOut={handlePressOut}>
      <Animated.View
        style={[styles.wrapper, { height: bannerHeight, transform: [{ scale: scaleAnim }] }]}
      >
        {variant === 'TEXT_LEFT'    && (
          <TextLeftLayout
            title={title} subtitle={subtitle} ctaText={ctaText}
            image={image} imagePosition={imagePosition} useSoftBlur={useSoftBlur}
            onPress={onPress}
          />
        )}
        {variant === 'CENTER_STACK' && (
          <CenterStackLayout
            title={title} subtitle={subtitle} ctaText={ctaText}
            image={image} useSoftBlur={useSoftBlur} onPress={onPress}
          />
        )}
        {variant === 'CARD_OVERLAY' && (
          <CardOverlayLayout
            title={title} subtitle={subtitle} ctaText={ctaText}
            image={image} useSoftBlur={useSoftBlur} onPress={onPress}
          />
        )}
      </Animated.View>
    </Pressable>
  );
}

// ── Internal layout helpers ───────────────────────────────────────────────────

type LayoutProps = Pick<HeroBannerProps,
  'title' | 'subtitle' | 'ctaText' | 'image' | 'imagePosition' | 'useSoftBlur' | 'onPress'
>;

/**
 * IMAGE_LEFT variant helper — returns the image container style based on position.
 * 'right'  → image rendered from the 25% mark; gradient covers the text area.
 * 'center' → image fills entire banner.
 * 'left'   → image rendered in left 75%.
 */
function imageContainerStyle(
  position: HeroBannerProps['imagePosition'],
): object {
  switch (position) {
    case 'right':
      return { position: 'absolute' as const, left: '25%', right: 0, top: 0, bottom: 0 };
    case 'left':
      return { position: 'absolute' as const, left: 0, right: '25%', top: 0, bottom: 0 };
    case 'center':
    default:
      return StyleSheet.absoluteFillObject;
  }
}

/**
 * TEXT_LEFT
 * Text zone occupies left ~46%; image favors the right side.
 * Horizontal gradient (dark-left → transparent-right) provides text legibility.
 */
function TextLeftLayout({ title, subtitle, ctaText, image, imagePosition = 'right', useSoftBlur = false, onPress }: LayoutProps) {
  return (
    <>
      {/* Optional soft blurred background layer */}
      {image && useSoftBlur && (
        <Image
          source={{ uri: image }}
          style={[StyleSheet.absoluteFillObject, { opacity: 0.35 }]}
          resizeMode="cover"
          blurRadius={14}
        />
      )}

      {/* Full-bleed image behind the overlay */}
      {image && (
        <Image
          source={{ uri: image }}
          style={StyleSheet.absoluteFillObject}
          resizeMode="cover"
        />
      )}

      {/* Full-width overlay — no split, text floats naturally over one unified image */}
      <LinearGradient
        colors={
          image
            ? ['rgba(0,0,0,0.55)', 'rgba(0,0,0,0.28)', 'rgba(0,0,0,0.06)', 'rgba(0,0,0,0.00)']
            : ['rgba(55,42,28,0.95)', 'rgba(35,26,18,1.0)', 'rgba(35,26,18,1.0)', 'rgba(35,26,18,1.0)']
        }
        start={{ x: 0, y: 0.5 }}
        end={{ x: 0.60, y: 0.5 }}
        style={StyleSheet.absoluteFillObject}
      />

      {/* Text zone — left 46% */}
      <View style={styles.textLeftZone}>
        <Text style={[styles.title, TEXT_SHADOW]}>{title}</Text>
        {subtitle ? (
          <Text style={[styles.subtitle, TEXT_SHADOW]}>{subtitle}</Text>
        ) : null}
        {ctaText && onPress ? (
          <TouchableOpacity style={styles.ctaBtn} activeOpacity={0.8} onPress={onPress}>
            <Text style={styles.ctaText}>{ctaText}</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    </>
  );
}

/**
 * CENTER_STACK
 * Full-bleed image, centered text, subtle dark overlay at bottom.
 */
function CenterStackLayout({ title, subtitle, ctaText, image, useSoftBlur = false, onPress }: LayoutProps) {
  return (
    <>
      {image && useSoftBlur && (
        <Image
          source={{ uri: image }}
          style={[StyleSheet.absoluteFillObject, { opacity: 0.30 }]}
          resizeMode="cover"
          blurRadius={14}
        />
      )}
      {image && (
        <Image
          source={{ uri: image }}
          style={StyleSheet.absoluteFillObject}
          resizeMode="cover"
        />
      )}
      <LinearGradient
        colors={
          image
            ? ['rgba(0,0,0,0.08)', 'rgba(0,0,0,0.58)']
            : ['rgba(55,42,28,0.85)', 'rgba(35,26,18,1.0)']
        }
        style={StyleSheet.absoluteFillObject}
      />
      <View style={styles.centerZone}>
        <Text style={[styles.title, styles.titleCenter, TEXT_SHADOW]}>{title}</Text>
        {subtitle ? (
          <Text style={[styles.subtitle, styles.subtitleCenter, TEXT_SHADOW]}>{subtitle}</Text>
        ) : null}
        {ctaText && onPress ? (
          <TouchableOpacity style={styles.ctaBtn} activeOpacity={0.8} onPress={onPress}>
            <Text style={styles.ctaText}>{ctaText}</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    </>
  );
}

/**
 * CARD_OVERLAY
 * Full-bleed image, white floating card at bottom-left. Premium editorial feel.
 */
function CardOverlayLayout({ title, subtitle, ctaText, image, useSoftBlur = false, onPress }: LayoutProps) {
  return (
    <>
      {image && useSoftBlur && (
        <Image
          source={{ uri: image }}
          style={[StyleSheet.absoluteFillObject, { opacity: 0.30 }]}
          resizeMode="cover"
          blurRadius={14}
        />
      )}
      {image ? (
        <Image
          source={{ uri: image }}
          style={StyleSheet.absoluteFillObject}
          resizeMode="cover"
        />
      ) : (
        <LinearGradient
          colors={['rgba(55,42,28,0.90)', 'rgba(35,26,18,1.0)']}
          style={StyleSheet.absoluteFillObject}
        />
      )}
      <View style={styles.floatingCard}>
        <Text style={styles.cardTitle}>{title}</Text>
        {subtitle ? (
          <Text style={styles.cardSubtitle}>{subtitle}</Text>
        ) : null}
        {ctaText && onPress ? (
          <TouchableOpacity style={[styles.ctaBtn, styles.ctaBtnDark]} activeOpacity={0.8} onPress={onPress}>
            <Text style={styles.ctaText}>{ctaText}</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    </>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  wrapper: {
    marginHorizontal: 6,
    marginBottom: 16,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: '#372D1A',   // warm dark fallback — never cold black
  },

  // TEXT_LEFT
  textLeftZone: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: '52%',
    justifyContent: 'flex-end',
    padding: 18,
    paddingBottom: 28,
  },

  // CENTER_STACK
  centerZone: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'flex-end',
    padding: 24,
    paddingBottom: 28,
  },

  // CARD_OVERLAY
  floatingCard: {
    position: 'absolute',
    bottom: 16,
    left: 16,
    backgroundColor: 'rgba(255,255,255,0.94)',
    borderRadius: 10,
    padding: 16,
    maxWidth: '62%',
  },
  cardTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1C1917',
    marginBottom: 4,
  },
  cardSubtitle: {
    fontSize: 12,
    color: '#6B7280',
    marginBottom: 12,
  },

  // Shared typography
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: '#FFFFFF',
    lineHeight: 30,
    marginBottom: 6,
  },
  titleCenter: {
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 14,
    fontWeight: '400',
    color: 'rgba(255,255,255,0.88)',
    lineHeight: 19,
    marginBottom: 10,
  },
  subtitleCenter: {
    textAlign: 'center',
  },

  // CTA button
  ctaBtn: {
    alignSelf: 'flex-start',
    backgroundColor: '#EAB320',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  ctaBtnDark: {
    backgroundColor: '#1C1917',
  },
  ctaText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '600',
  },
});
