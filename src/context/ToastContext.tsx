import React, { createContext, useCallback, useContext, useRef, useState } from 'react';
import { Animated, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

interface ToastOptions {
  actionLabel?: string;
  onAction?: () => void;
}

interface ToastContextValue {
  showToast: (message: string, options?: ToastOptions) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

interface ToastState {
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}

export function ToastStack({ children }: { children: React.ReactNode }) {
  const [toast, setToast] = useState<ToastState>({ message: '' });
  const [visible, setVisible] = useState(false);
  const translateY = useRef(new Animated.Value(16)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dismiss = useCallback(() => {
    Animated.parallel([
      Animated.timing(translateY, { toValue: 12, duration: 200, useNativeDriver: true }),
      Animated.timing(opacity, { toValue: 0, duration: 200, useNativeDriver: true }),
    ]).start(() => setVisible(false));
  }, [translateY, opacity]);

  const showToast = useCallback(
    (message: string, options?: ToastOptions) => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }

      setToast({ message, actionLabel: options?.actionLabel, onAction: options?.onAction });
      setVisible(true);
      translateY.setValue(16);
      opacity.setValue(0);

      Animated.parallel([
        Animated.spring(translateY, {
          toValue: 0,
          useNativeDriver: true,
          speed: 24,
          bounciness: 4,
        }),
        Animated.timing(opacity, {
          toValue: 1,
          duration: 120,
          useNativeDriver: true,
        }),
      ]).start();

      timer.current = setTimeout(dismiss, 2600);
    },
    [translateY, opacity, dismiss],
  );

  const handleAction = () => {
    if (timer.current) clearTimeout(timer.current);
    dismiss();
    toast.onAction?.();
  };

  return (
    <ToastContext.Provider value={{ showToast }}>
      <View style={{ flex: 1 }}>
        {children}
        {visible && (
          <Animated.View
            pointerEvents="box-none"
            style={[styles.toast, { opacity, transform: [{ translateY }] }]}
          >
            <Text style={styles.message}>{toast.message}</Text>
            {toast.actionLabel && (
              <>
                <View style={styles.divider} />
                <TouchableOpacity onPress={handleAction} activeOpacity={0.65} hitSlop={{ top: 8, bottom: 8, left: 8, right: 4 }}>
                  <Text style={styles.action}>{toast.actionLabel}</Text>
                </TouchableOpacity>
              </>
            )}
          </Animated.View>
        )}
      </View>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be inside ToastStack');
  return ctx;
}

const styles = StyleSheet.create({
  toast: {
    position: 'absolute',
    bottom: 96,
    left: 20,
    right: 20,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.07)',
    shadowColor: '#1C1917',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 12,
    elevation: 6,
  },
  message: {
    flex: 1,
    fontSize: 13,
    fontWeight: '500',
    color: '#1C1917',
    letterSpacing: 0.1,
  },
  divider: {
    width: 1,
    height: 14,
    backgroundColor: '#E5E7EB',
    marginHorizontal: 12,
  },
  action: {
    fontSize: 13,
    fontWeight: '600',
    color: '#EAB320',
    letterSpacing: 0.1,
  },
});
