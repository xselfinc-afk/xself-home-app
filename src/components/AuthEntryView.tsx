/**
 * AuthEntryView — the single source of truth for the login / guest-entry UI + logic.
 *
 * Extracted from the former App.tsx SignInEntryScreen so ONE component serves both:
 *   A. the standalone full-screen startup login (root auth gate) — pass no `onDone`;
 *      the root gate swaps to Main automatically when auth state changes.
 *   B. the in-app SignInEntry route (Account / Checkout / Earn) — pass `onDone` to
 *      return to the guarded workflow after guest/sign-in.
 *
 * Owns: OTP send/verify, guest continuation, email validation, loading + error state,
 * resend cooldown, and the Terms/Privacy fine print. No navigation dependency — it
 * calls useAuth() and invokes `onDone?.()` after a successful guest choice or sign-in.
 */
import React, { useState, useRef, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, ActivityIndicator,
  Animated, KeyboardAvoidingView, Platform, StyleSheet, SafeAreaView, StatusBar,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../context/AuthContext';
import { supabaseConfigured } from '../lib/supabase';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export default function AuthEntryView({ onDone }: { onDone?: () => void }) {
  const { sendOtp, verifyOtp, continueAsGuest } = useAuth();
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [step, setStep] = useState<'email' | 'otp'>('email');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [emailKey, setEmailKey] = useState(0);
  const [resendCooldown, setResendCooldown] = useState(0);
  const [otpError, setOtpError] = useState(false);

  const emailValid = EMAIL_RE.test(email.trim());
  const otpRef = useRef<any>(null);
  const scrollRef = useRef<ScrollView>(null);
  const stepAnim = useRef(new Animated.Value(1)).current;
  const shakeAnim = useRef(new Animated.Value(0)).current;
  const cooldownRef = useRef<any>(null);

  useEffect(() => {
    return () => { if (cooldownRef.current) clearInterval(cooldownRef.current); };
  }, []);

  useEffect(() => {
    if (step === 'otp') {
      const t = setTimeout(() => otpRef.current?.focus(), 320);
      return () => clearTimeout(t);
    }
  }, [step]);

  const startCooldown = (seconds = 30) => {
    if (cooldownRef.current) clearInterval(cooldownRef.current);
    setResendCooldown(seconds);
    cooldownRef.current = setInterval(() => {
      setResendCooldown(prev => {
        if (prev <= 1) { clearInterval(cooldownRef.current); cooldownRef.current = null; return 0; }
        return prev - 1;
      });
    }, 1000);
  };

  const fadeTransition = (callback: () => void) => {
    Animated.timing(stepAnim, { toValue: 0, duration: 140, useNativeDriver: true }).start(() => {
      callback();
      Animated.timing(stepAnim, { toValue: 1, duration: 200, useNativeDriver: true }).start();
    });
  };

  const shakeOtp = () => {
    setOtpError(true);
    Animated.sequence([
      Animated.timing(shakeAnim, { toValue: -10, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 10, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: -7, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 7, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 0, duration: 50, useNativeDriver: true }),
    ]).start(() => setTimeout(() => setOtpError(false), 1600));
  };

  const handleContinue = async () => {
    if (!emailValid || loading) return;
    setLoading(true);
    setError(null);
    const { error: err } = await sendOtp(email.trim().toLowerCase());
    setLoading(false);
    if (err) { setError('Failed to send email. Try again.'); return; }
    startCooldown(30);
    fadeTransition(() => setStep('otp'));
  };

  const handleVerify = async () => {
    if (otp.length < 6 || loading) return;
    setLoading(true);
    setError(null);
    const { error: err } = await verifyOtp(email.trim().toLowerCase(), otp);
    setLoading(false);
    if (err) { setError('Invalid or expired code. Please try again.'); shakeOtp(); return; }
    // Successful sign-in: AuthContext has set the session/user. The root gate swaps
    // to Main automatically; the in-app route returns to its caller via onDone.
    onDone?.();
  };

  const handleResend = async () => {
    if (loading || resendCooldown > 0) return;
    setLoading(true);
    setError(null);
    const { error: err } = await sendOtp(email.trim().toLowerCase());
    setLoading(false);
    startCooldown(30);
    if (err) {
      setError("We couldn't send a new code right now. Please wait a moment and try again.");
    }
  };

  const handleChangeEmail = () => {
    fadeTransition(() => {
      setEmail('');
      setOtp('');
      setError(null);
      setLoading(false);
      setOtpError(false);
      setStep('email');
      setEmailKey(k => k + 1);
    });
  };

  const handleGuest = () => {
    continueAsGuest();
    onDone?.();
  };

  const stepTitle = step === 'email' ? 'Sign in to Xself' : 'Check your email';
  const stepSubtitle = step === 'email'
    ? 'Save favorites, track orders, and unlock member rewards.'
    : `We sent a 6-digit code to\n${email.trim().toLowerCase()}`;

  return (
    <View style={{ flex: 1 }}>
      {/* Full-screen branded login background — already contains the Xself Home logo,
          wordmark, and "Shop Smart. Live Better." slogan. No overlay: the image's top is
          dark enough for the light status bar and the white sign-in card is opaque. */}
      <Image
        source={require('../../assets/auth/login-background.jpg')}
        style={StyleSheet.absoluteFillObject}
        contentFit="cover"
        cachePolicy="memory-disk"
        transition={150}
      />
      <SafeAreaView style={{ flex: 1 }}>
      <StatusBar barStyle="light-content" />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <ScrollView
          ref={scrollRef}
          contentContainerStyle={styles.signInWrap}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* Top brand logo removed — the background image already contains the Xself Home
              logo, wordmark, and "Shop Smart. Live Better." slogan, so a separate logo here
              would duplicate it. The card is bottom-anchored (see signInWrap) so the image's
              branding stays visible above it. */}
          <View style={styles.signInCard}>
            <Animated.View style={{ opacity: stepAnim }}>
              <Text style={styles.signInTitle}>{stepTitle}</Text>
              <Text style={styles.signInSubtitle}>{stepSubtitle}</Text>

              {step === 'email' ? (
                <>
                  {!supabaseConfigured && __DEV__ && (
                    <View style={styles.configWarning}>
                      <Ionicons name="warning-outline" size={13} color="#92400E" />
                      <Text style={styles.configWarningText}>
                        Add credentials to .env and restart: npx expo start --clear
                      </Text>
                    </View>
                  )}

                  <View style={[styles.signInInputRow, !supabaseConfigured && { opacity: 0.4 }]}>
                    <Ionicons name="mail-outline" size={18} color="#6B7280" />
                    <TextInput
                      key={emailKey}
                      style={styles.signInInput}
                      placeholder="Email address"
                      placeholderTextColor="#9CA3AF"
                      autoCapitalize="none"
                      autoCorrect={false}
                      keyboardType="email-address"
                      editable={supabaseConfigured}
                      value={email}
                      onChangeText={t => { setEmail(t); setError(null); }}
                      returnKeyType="done"
                      onSubmitEditing={handleContinue}
                    />
                  </View>

                  {supabaseConfigured && error ? (
                    <Text style={styles.signInError}>{error}</Text>
                  ) : null}

                  <TouchableOpacity
                    style={[styles.primaryBtn, (!emailValid || loading || !supabaseConfigured) && { opacity: 0.4 }]}
                    onPress={handleContinue}
                    disabled={!emailValid || loading || !supabaseConfigured}
                  >
                    {loading
                      ? <ActivityIndicator color="white" size="small" />
                      : <Text style={styles.primaryBtnText}>Continue</Text>}
                  </TouchableOpacity>

                  <View style={styles.signInDivider}>
                    <View style={styles.signInDividerLine} />
                    <Text style={styles.signInDividerText}>or</Text>
                    <View style={styles.signInDividerLine} />
                  </View>

                  <TouchableOpacity onPress={handleGuest} style={styles.guestBtn}>
                    <Text style={styles.guestBtnText}>Continue as Guest</Text>
                  </TouchableOpacity>
                </>
              ) : (
                <>
                  {/* 6-slot segmented OTP display */}
                  <Animated.View style={[styles.otpBoxRow, { transform: [{ translateX: shakeAnim }] }]}>
                    {Array.from({ length: 6 }).map((_, i) => {
                      const isFilled = i < otp.length;
                      const isActive = i === otp.length && !loading;
                      return (
                        <TouchableOpacity
                          key={i}
                          activeOpacity={1}
                          onPress={() => otpRef.current?.focus()}
                          style={[
                            styles.otpBox,
                            isFilled && styles.otpBoxFilled,
                            !isFilled && isActive && styles.otpBoxActive,
                            otpError && styles.otpBoxError,
                          ]}
                        >
                          <Text style={styles.otpBoxText}>{otp[i] ?? ''}</Text>
                        </TouchableOpacity>
                      );
                    })}
                  </Animated.View>

                  {/* Hidden input captures keyboard typing, paste, and iOS autofill */}
                  <TextInput
                    ref={otpRef}
                    value={otp}
                    onChangeText={t => {
                      const digits = t.replace(/\D/g, '').slice(0, 6);
                      if (digits.length === 6 || Math.abs(digits.length - otp.length) <= 1) {
                        setOtpError(false);
                        setError(null);
                        setOtp(digits);
                      }
                    }}
                    onFocus={() => {
                      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 150);
                    }}
                    keyboardType="number-pad"
                    textContentType="oneTimeCode"
                    autoComplete="sms-otp"
                    maxLength={6}
                    style={styles.otpHiddenInput}
                    caretHidden
                  />

                  {error ? <Text style={styles.signInError}>{error}</Text> : null}

                  <TouchableOpacity
                    style={[styles.primaryBtn, (otp.length < 6 || loading) && { opacity: 0.4 }]}
                    onPress={handleVerify}
                    disabled={otp.length < 6 || loading}
                  >
                    {loading
                      ? <ActivityIndicator color="white" size="small" />
                      : <Text style={styles.primaryBtnText}>Verify</Text>}
                  </TouchableOpacity>

                  <View style={styles.otpActionRow}>
                    <TouchableOpacity
                      onPress={handleResend}
                      disabled={loading || resendCooldown > 0}
                      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                    >
                      <Text style={[styles.otpActionText, (loading || resendCooldown > 0) && styles.otpActionTextDim]}>
                        {resendCooldown > 0 ? `Resend in ${resendCooldown}s` : 'Resend code'}
                      </Text>
                    </TouchableOpacity>
                    <Text style={styles.otpActionSep}>·</Text>
                    <TouchableOpacity
                      onPress={handleChangeEmail}
                      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                    >
                      <Text style={styles.otpActionText}>Change email</Text>
                    </TouchableOpacity>
                  </View>

                  <Text style={styles.otpSpamHint}>Didn't get it? Check spam or promotions first.</Text>
                </>
              )}

              <Text style={styles.signInFinePrint}>
                By continuing, you agree to our Terms and Privacy Policy.
              </Text>
            </Animated.View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
      </SafeAreaView>
    </View>
  );
}

// Styles copied verbatim from the former App.tsx SignInEntry styles so this component
// is self-contained (values unchanged — preserves the approved visual design).
const styles = StyleSheet.create({
  // Bottom-anchored so the sign-in card sits over the lower (interior) half of the branded
  // background, leaving the image's own logo/wordmark/slogan visible in the top half.
  signInWrap: { flexGrow: 1, justifyContent: 'flex-end', paddingTop: 24, paddingBottom: 48 },
  signInCard: { padding: 24, marginHorizontal: 24, backgroundColor: '#FFFFFF', borderRadius: 6, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 12, elevation: 2 },
  signInTitle: { fontSize: 22, fontWeight: '700', color: '#111827' },
  signInSubtitle: { fontSize: 14, color: '#6B7280', marginTop: 8, lineHeight: 20 },
  signInInputRow: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#F3F4F6', borderRadius: 8, paddingHorizontal: 14, marginTop: 16 },
  signInInput: { flex: 1, paddingVertical: 12, fontSize: 15, color: '#1C1917' },
  signInFinePrint: { fontSize: 11, color: '#9CA3AF', marginTop: 12, lineHeight: 16 },
  signInError: { fontSize: 12, color: '#DC2626', marginTop: 8, marginBottom: 2 },
  configWarning: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, backgroundColor: '#FEF3C7', borderRadius: 6, padding: 10, marginTop: 10 },
  configWarningText: { fontSize: 12, color: '#92400E', flex: 1, lineHeight: 16 },
  signInDivider: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 14, marginBottom: 2 },
  signInDividerLine: { flex: 1, height: 1, backgroundColor: '#E5E7EB' },
  signInDividerText: { fontSize: 12, color: '#9CA3AF', fontWeight: '500' },
  guestBtn: { paddingVertical: 13, borderRadius: 8, alignItems: 'center', borderWidth: 1, borderColor: '#E5E7EB', marginTop: 10 },
  guestBtnText: { fontSize: 15, fontWeight: '600', color: '#374151' },
  otpBoxRow: { flexDirection: 'row', gap: 8, marginTop: 20, marginBottom: 4 },
  otpBox: { flex: 1, aspectRatio: 1, borderRadius: 8, borderWidth: 1, borderColor: '#E8E5DF', alignItems: 'center', justifyContent: 'center', backgroundColor: '#FAFAF9' },
  otpBoxFilled: { borderColor: '#403F3D', borderWidth: 1.5, backgroundColor: '#FFFFFF' },
  otpBoxActive: { borderColor: '#EAB320', borderWidth: 1.5, backgroundColor: '#FFFDF5' },
  otpBoxError: { borderColor: '#DC2626', borderWidth: 1.5, backgroundColor: '#FEF2F2' },
  otpBoxText: { fontSize: 17, fontWeight: '600', color: '#403F3D' },
  otpHiddenInput: { position: 'absolute', width: 0, height: 0, opacity: 0 },
  otpActionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 16 },
  otpActionText: { fontSize: 13, color: '#6B7280', fontWeight: '500' },
  otpActionTextDim: { color: '#D1D5DB' },
  otpActionSep: { fontSize: 13, color: '#D1D5DB' },
  otpSpamHint: { fontSize: 12, color: '#9CA3AF', textAlign: 'center', marginTop: 12, lineHeight: 17 },
  primaryBtn: { backgroundColor: '#F4B740', height: 58, borderRadius: 14, alignItems: 'center', justifyContent: 'center', marginTop: 14 },
  primaryBtnText: { color: 'white', fontSize: 15, fontWeight: '700' },
});
