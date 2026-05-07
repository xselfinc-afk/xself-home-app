import React, { createContext, useContext, useRef, useState } from 'react';
import { Animated, Dimensions, Easing, StyleSheet, View } from 'react-native';
import { Image } from 'expo-image';
import { variantUrl } from '../utils/imageVariant';

interface CartAnimContextValue {
  triggerAnimation: (startX: number, startY: number, imgUrl?: string) => void;
  setCartTarget: (x: number, y: number) => void;
}

const CartAnimContext = createContext<CartAnimContextValue | null>(null);

const SCREEN_H = Dimensions.get('window').height;
const SCREEN_W = Dimensions.get('window').width;
const DOT_SIZE = 36;
const PARTICLE_SIZE = 5;
const NUM_PARTICLES = 8;

// Fixed spread distances per particle — varied for organic feel
const SPREADS = [26, 34, 22, 30, 28, 20, 32, 24];
// Angles: 8 evenly spaced, offset by π/8 so they avoid pure cardinal directions
const ANGLES = Array.from({ length: NUM_PARTICLES }, (_, i) => (i * Math.PI * 2) / NUM_PARTICLES + Math.PI / 8);

export function CartAnimProvider({ children }: { children: React.ReactNode }) {
  // ── Flying thumbnail state ──────────────────────────────────────────────────
  const [dotPos, setDotPos] = useState<{ x: number; y: number; imgUrl?: string } | null>(null);
  const animX = useRef(new Animated.Value(0)).current;
  const animY = useRef(new Animated.Value(0)).current;
  const dotOpacity = useRef(new Animated.Value(0)).current;
  const dotScale = useRef(new Animated.Value(1)).current;

  // ── Particle burst state ────────────────────────────────────────────────────
  const [particleOrigin, setParticleOrigin] = useState<{ x: number; y: number } | null>(null);
  // Pre-created animated values — never recreated
  const particles = useRef(
    Array.from({ length: NUM_PARTICLES }, (_, i) => ({
      tx: new Animated.Value(0),
      ty: new Animated.Value(0),
      scale: new Animated.Value(1),
      opacity: new Animated.Value(0),
      angle: ANGLES[i],
      spread: SPREADS[i],
    })),
  ).current;

  // Dynamic target — updated by CustomTabBar once the cart icon is measured
  const cartTargetX = useRef(SCREEN_W * 0.625);
  const cartTargetY = useRef(SCREEN_H - 88);

  const setCartTarget = (x: number, y: number) => {
    cartTargetX.current = x;
    cartTargetY.current = y;
  };

  const triggerAnimation = (startX: number, startY: number, imgUrl?: string) => {
    // ── 1. Particle burst — fires immediately at tap point ──────────────────
    setParticleOrigin({ x: startX, y: startY });
    particles.forEach(p => {
      p.tx.setValue(0);
      p.ty.setValue(0);
      p.scale.setValue(1);
      p.opacity.setValue(1);
    });
    Animated.parallel(
      particles.map(p =>
        Animated.parallel([
          Animated.timing(p.tx, {
            toValue: Math.cos(p.angle) * p.spread,
            duration: 290,
            easing: Easing.out(Easing.quad),
            useNativeDriver: true,
          }),
          Animated.timing(p.ty, {
            toValue: Math.sin(p.angle) * p.spread,
            duration: 290,
            easing: Easing.out(Easing.quad),
            useNativeDriver: true,
          }),
          Animated.timing(p.scale, {
            toValue: 0,
            duration: 290,
            easing: Easing.in(Easing.quad),
            useNativeDriver: true,
          }),
          Animated.timing(p.opacity, {
            toValue: 0,
            duration: 270,
            easing: Easing.in(Easing.quad),
            useNativeDriver: true,
          }),
        ]),
      ),
    ).start(() => setParticleOrigin(null));

    // ── 2. Fly-to-cart — starts 55ms after burst so burst reads first ────────
    setTimeout(() => {
      animX.setValue(startX);
      animY.setValue(startY);
      dotOpacity.setValue(1);
      dotScale.setValue(1);
      setDotPos({ x: startX, y: startY, imgUrl });

      const tx = cartTargetX.current;
      const ty = cartTargetY.current;

      Animated.parallel([
        Animated.timing(animX, {
          toValue: tx,
          duration: 520,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.sequence([
          Animated.timing(animY, {
            toValue: startY - 56,
            duration: 200,
            easing: Easing.out(Easing.quad),
            useNativeDriver: true,
          }),
          Animated.timing(animY, {
            toValue: ty,
            duration: 320,
            easing: Easing.in(Easing.cubic),
            useNativeDriver: true,
          }),
        ]),
        Animated.timing(dotScale, {
          toValue: 0.2,
          duration: 520,
          easing: Easing.in(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.sequence([
          Animated.timing(dotOpacity, { toValue: 1, duration: 40, useNativeDriver: true }),
          Animated.delay(320),
          Animated.timing(dotOpacity, { toValue: 0, duration: 160, useNativeDriver: true }),
        ]),
      ]).start(() => setDotPos(null));
    }, 55);
  };

  return (
    <CartAnimContext.Provider value={{ triggerAnimation, setCartTarget }}>
      <View style={{ flex: 1 }}>
        {children}

        {/* Particle burst — at tap point */}
        {particleOrigin &&
          particles.map((p, i) => (
            <Animated.View
              key={i}
              pointerEvents="none"
              style={[
                styles.particle,
                {
                  left: particleOrigin.x - PARTICLE_SIZE / 2,
                  top: particleOrigin.y - PARTICLE_SIZE / 2,
                  opacity: p.opacity,
                  transform: [{ translateX: p.tx }, { translateY: p.ty }, { scale: p.scale }],
                },
              ]}
            />
          ))}

        {/* Flying thumbnail — from tap point to cart icon */}
        {dotPos && (
          <Animated.View
            pointerEvents="none"
            style={[
              styles.dot,
              {
                opacity: dotOpacity,
                transform: [
                  { translateX: Animated.subtract(animX, new Animated.Value(DOT_SIZE / 2)) },
                  { translateY: Animated.subtract(animY, new Animated.Value(DOT_SIZE / 2)) },
                  { scale: dotScale },
                ],
              },
            ]}
          >
            {dotPos.imgUrl ? (
              <Image source={{ uri: variantUrl(dotPos.imgUrl, { width: 320 }) }} style={styles.dotImage} contentFit="cover" cachePolicy="memory-disk" />
            ) : null}
          </Animated.View>
        )}
      </View>
    </CartAnimContext.Provider>
  );
}

export function useCartAnimation(): CartAnimContextValue {
  const ctx = useContext(CartAnimContext);
  if (!ctx) throw new Error('useCartAnimation must be used inside CartAnimProvider');
  return ctx;
}

const styles = StyleSheet.create({
  particle: {
    position: 'absolute',
    width: PARTICLE_SIZE,
    height: PARTICLE_SIZE,
    borderRadius: PARTICLE_SIZE / 2,
    backgroundColor: '#EAB320',
  },
  dot: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: DOT_SIZE,
    height: DOT_SIZE,
    borderRadius: 8,
    backgroundColor: '#EAB320',
    overflow: 'hidden',
    borderWidth: 1.5,
    borderColor: 'rgba(234,179,32,0.5)',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.18,
    shadowRadius: 4,
    elevation: 4,
  },
  dotImage: {
    width: '100%',
    height: '100%',
  },
});
