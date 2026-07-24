/**
 * Login-to-front / auth-gate invariants (source-structure test; the repo has no RN
 * renderer in its test tooling, so we lock the gate against the App.tsx / AuthContext /
 * AuthEntryView sources). Run: npx tsx src/__tests__/authGate.test.ts  (from repo root)
 *
 * Covers the 10 required behaviors:
 *  1. auth not ready → native splash held (no app content rendered)
 *  2. unauthenticated & not guest → standalone LoginEntry
 *  3. authenticated → Main
 *  4. explicit guest → Main
 *  5. sign out → standalone LoginEntry (not silent guest)
 *  6. no SplashOverlay/JS splash remains
 *  7. in-app SignInEntry route remains registered
 *  8. LoginEntry is structurally outside TabNavigator
 *  9. Continue as Guest opens Home (Main → Home tab)
 * 10. returning authenticated user bypasses LoginEntry
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }

const app = readFileSync(join(process.cwd(), 'App.tsx'), 'utf8');
const ctx = readFileSync(join(process.cwd(), 'src/context/AuthContext.tsx'), 'utf8');
const view = readFileSync(join(process.cwd(), 'src/components/AuthEntryView.tsx'), 'utf8');

console.log('auth gate tests (login-to-front)');

it('1. auth not ready → native splash held, no app content', () => {
  assert.ok(ctx.includes('authReady'), 'AuthContext exposes authReady');
  assert.ok(app.includes('if (!authReady) return null'), 'RootNavigation renders nothing until authReady');
  assert.ok(app.includes('SplashScreen.hideAsync()'), 'native splash released on authReady');
  assert.ok(app.includes('SplashScreen.preventAutoHideAsync()'), 'native splash held at startup');
});

it('2/3/4. gate: entered (user || guest) → Main; else → LoginEntry', () => {
  assert.ok(app.includes('const entered = !!user || isGuest'), 'entered = authed OR explicit guest');
  const iEntered = app.indexOf('entered ? (');
  assert.ok(iEntered >= 0, 'gate ternary present');
  const iMain = app.indexOf('name="Main"');
  const iLogin = app.indexOf('name="LoginEntry"');
  assert.ok(iMain > iEntered && iLogin > iMain, 'entered→Main, else→LoginEntry (Main before LoginEntry in the ternary)');
});

it('5. sign out returns to LoginEntry (isGuest=false, not silent guest)', () => {
  // signOut clears user/session AND sets isGuest false → gate `entered` becomes false.
  const so = ctx.slice(ctx.indexOf('const signOut'), ctx.indexOf('const deleteAccount'));
  assert.ok(so.includes('setUser(null)') && so.includes('setIsGuest(false)'), 'signOut clears user and sets guest=false');
  assert.equal(ctx.includes('const signOut = async () => {\n    await supabase.auth.signOut();\n    setUser(null);\n    setSession(null);\n    setIsGuest(true);'), false, 'old silent-guest signOut removed');
});

it('6. no custom JS splash remains', () => {
  assert.equal(app.includes('SplashOverlay'), false, 'SplashOverlay removed');
  assert.equal(app.includes('showSplash'), false, 'showSplash removed');
  assert.equal(app.includes('splashOpacity'), false, 'splashOpacity removed');
});

it('7. in-app SignInEntry route remains registered + reuses AuthEntryView', () => {
  assert.ok(app.includes('name="SignInEntry" component={SignInEntryScreen}'), 'SignInEntry route registered');
  assert.ok(app.includes('<AuthEntryView onDone={() => navigation.goBack()} />'), 'in-app SignInEntry reuses AuthEntryView, returns to caller');
  assert.ok(app.includes('AccountStack.Screen name="SignInEntry"'), 'Account stack keeps SignInEntry for guest→sign-in');
});

it('8. LoginEntry is structurally outside TabNavigator', () => {
  // LoginEntry lives in the AuthGate stack; TabNavigator only appears in the Main stack.
  assert.ok(app.includes('id="AuthGate"'), 'separate AuthGate navigator exists');
  const authGate = app.slice(app.indexOf('id="AuthGate"'));
  assert.equal(authGate.slice(0, authGate.indexOf('</Stack.Navigator>')).includes('TabNavigator'), false, 'AuthGate does not mount TabNavigator');
  assert.ok(app.includes('component={LoginEntryScreen}'), 'LoginEntry screen mounted in AuthGate');
  assert.ok(app.includes('return <AuthEntryView />;'), 'standalone LoginEntry uses AuthEntryView (no onDone; gate swaps on auth change)');
});

it('9. Continue as Guest opens Home (Main initial route + Home first tab)', () => {
  assert.ok(view.includes('continueAsGuest()'), 'guest handler calls continueAsGuest');
  assert.ok(app.includes('initialRouteName="Main"'), 'entered stack opens Main');
  const tab = app.slice(app.indexOf('<Tab.Navigator'));
  assert.ok(tab.indexOf('name="Home"') < tab.indexOf('name="Discover"'), 'Home is the first/default tab');
});

it('10. returning authenticated user bypasses LoginEntry', () => {
  assert.ok(ctx.includes('supabase.auth.getSession()'), 'cold-start restores session');
  assert.ok(ctx.includes('if (s) applySession(s)'), 'restored session → authenticated (user set)');
  // No auto-guest on no-session → unauthenticated shows LoginEntry, authenticated → Main.
  assert.equal(ctx.includes('else { setIsGuest(true); }'), false, 'no silent auto-guest on cold start');
});

it('AuthEntryView is the single source of truth (OTP + guest + validation + Terms)', () => {
  assert.ok(view.includes('sendOtp') && view.includes('verifyOtp'), 'OTP logic lives in AuthEntryView');
  assert.ok(view.includes('continueAsGuest'), 'guest logic lives in AuthEntryView');
  assert.ok(view.includes('EMAIL_RE'), 'email validation lives in AuthEntryView');
  assert.ok(view.includes('Terms and Privacy Policy'), 'Terms/Privacy text present');
  assert.equal(app.includes('const emailValid = EMAIL_RE'), false, 'login logic no longer duplicated in App.tsx');
});

it('OTP + magic-link + session restore preserved; no new linking config', () => {
  assert.ok(ctx.includes('signInWithOtp') && ctx.includes('verifyOtp'), 'OTP preserved');
  assert.ok(ctx.includes('handleMagicLink') && ctx.includes("Linking.addEventListener('url'"), 'magic-link callback preserved');
  assert.equal(app.includes('linking='), false, 'no new React Navigation linking config added');
});

console.log(`\n${passed} passed`);
