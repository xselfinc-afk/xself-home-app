import React, { createContext, useContext, useRef, useState } from 'react';
import { Animated, Dimensions, StyleSheet, View } from 'react-native';

interface CartAnimContextValue {
  triggerAnimation: (startX: number, startY: number) => void;
}

const CartAnimContext = createContext<CartAnimContextValue | null>(null);

const SCREEN_H = Dimensions.get('window').height;
const SCREEN_W = Dimensions.get('window').width;
// Approximate center-x of the Cart tab (3rd of 4 tabs)
const TARGET_X = SCREEN_W * 0.625;
const TARGET_Y = SCREEN_H - 52;

export function CartAnimProvider({ children }: { children: React.ReactNode }) {
  const [dotPos, setDotPos] = useState<{ x: number; y: number } | null>(null);
  const animX = useRef(new Animated.Value(0)).current;
  const animY = useRef(new Animated.Value(0)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  const scale = useRef(new Animated.Value(1)).current;

  const triggerAnimation = (startX: number, startY: number) => {
    animX.setValue(startX);
    animY.setValue(startY);
    opacity.setValue(1);
    scale.setValue(1);
    setDotPos({ x: startX, y: startY });

    Animated.parallel([
      Animated.timing(animX, {
        toValue: TARGET_X,
        duration: 480,
        useNativeDriver: true,
      }),
      Animated.timing(animY, {
        toValue: TARGET_Y,
        duration: 480,
        useNativeDriver: true,
      }),
      Animated.timing(scale, {
        toValue: 0.25,
        duration: 480,
        useNativeDriver: true,
      }),
      Animated.sequence([
        Animated.timing(opacity, { toValue: 1, duration: 40, useNativeDriver: true }),
        Animated.delay(300),
        Animated.timing(opacity, { toValue: 0, duration: 140, useNativeDriver: true }),
      ]),
    ]).start(() => setDotPos(null));
  };

  return (
    <CartAnimContext.Provider value={{ triggerAnimation }}>
      <View style={{ flex: 1 }}>
        {children}
        {dotPos && (
          <Animated.View
            pointerEvents="none"
            style={[
              styles.dot,
              {
                opacity,
                transform: [
                  { translateX: Animated.subtract(animX, new Animated.Value(12)) },
                  { translateY: Animated.subtract(animY, new Animated.Value(12)) },
                  { scale },
                ],
              },
            ]}
          />
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
  dot: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: '#CA8A04',
  },
});
