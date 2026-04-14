export const colors = {
  // Brand
  ink: '#1C1917',
  amber: '#CA8A04',

  // Backgrounds
  canvas: '#FAFAF9',
  surface: '#FFFFFF',
  muted: '#F3F4F6',
  mutedAlt: '#F5F5F4',

  // Text
  textPrimary: '#1C1917',
  textSecondary: '#6B7280',
  textTertiary: '#9CA3AF',

  // Accents
  star: '#FBBF24',
  danger: '#DC2626',
  success: '#059669',

  // Borders
  border: '#E5E7EB',
  borderFaint: 'rgba(17,24,39,0.10)',
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  full: 999,
} as const;

export const typography = {
  labelSm: { fontSize: 10, fontWeight: '600' as const },
  labelMd: { fontSize: 12, fontWeight: '500' as const },
  body: { fontSize: 14, fontWeight: '400' as const },
  bodyMd: { fontSize: 15, fontWeight: '400' as const },
  title: { fontSize: 16, fontWeight: '600' as const },
  titleLg: { fontSize: 20, fontWeight: '600' as const },
  display: { fontSize: 24, fontWeight: '700' as const },
} as const;
