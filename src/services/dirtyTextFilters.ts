/**
 * Source of truth: /NORMALIZATION_ENGINE.md
 * All product title, features, description, specifications, image, and family logic must follow this file.
 * Do NOT add UI-side cleaning or formatting logic.
 *
 * Dirty text filter patterns.
 * Shared by featureGenerator (key_features_json) and featureGenerator via buildDescription (short_description).
 * Any text that matches these patterns must never appear in normalized product fields.
 */

export const SKIP_DESC_PATTERNS: RegExp[] = [
  /assembly\s+required/i,
  /do\s+not\s+(wash|bleach|iron)/i,
  /warning:/i,
  /note:/i,
  /^[\d\s.]+$/,          // bare numbers/measurements
  /^\s*[-–•*]+\s*$/,     // bare bullet chars
];

export const SKIP_BULLET_PATTERNS: RegExp[] = [
  /assembly\s+required/i,
  /^please\s+(note|read|check)/i,
  /^warning/i,
  /^note:/i,
  /do\s+not\s+(wash|bleach|iron)/i,
  /^[\d\s.x×*-]+$/,
  // Spec fields — belong in Product Details, not Key Features
  /^\s*(material|color|colour|finish|weight\b|dimensions?\b|overall|assembled|length\b|width\b|height\b|depth\b|sku\b|model\s*(?:number|no\.?)\b|item\s*(?:number|no\.?)\b|category\b|country\s*of\s*origin\b|product\s*type\b|net\s*weight\b|gross\s*weight\b)[:：\s]/i,
  /^\d+(\.\d+)?\s*['""]?\s*[×xX]\s*\d+(\.\d+)?\s*['""]?/, // WxHxD pattern
  /^\d+(\.\d+)?\s*(lbs?|kg|oz|g)\s*$/i,
  /\d+\s*['"]\s*[Hh]\s*[Xx×]\s*\d/,              // dimension phrases like 30"H x 20"W
  // Material-only lines (no usage context)
  /^\s*(particle\s*board|mdf|engineered\s*wood|solid\s*wood|hardwood)\s*$/i,
  // Bare dimension shorthand like "W48 x D20 x H30"
  /\b[WHDwhd]\s*\d+(\.\d+)?\s*[""']?\s*[×xX]/,
  // Lines that are purely size measurements
  /^\s*\d+(\.\d+)?\s*[""']?\s*(wide|deep|tall|high|long)\s*$/i,
  // Mid-sentence weight values — "weighs 134 lbs", "134 lb", "43.5 pounds"
  /\b\d+(\.\d+)?\s*(lbs?|lb|pounds?)\b/i,
  // "product dimensions", "product size", "product weight" anywhere in sentence
  /\bproduct\s+(dimensions?|size|weight)\b/i,
  // "overall dimensions/size", "assembled dimensions/weight"
  /\b(overall|assembled)\s+(dimensions?|size|weight)\b/i,
  // "measures 43...", "measuring 15 inches"
  /\b(measures?|measuring)\s+\d/i,
  // "43 inches wide/tall/deep/long"
  /\b\d+(\.\d+)?\s*(inches?|in\.)\s*(wide|tall|deep|long|high)\b/i,
  // Supplier section headers — "Selling Points: ...", "Assembly Kit: Yes"
  /^selling\s+points?\s*[:：]/i,
  /^assembly\s+(kit|steps?|instructions?|guide|manual|time)\b/i,
  // Labeled dimension fields — "Internal space size:", "Package size:"
  /^(internal|external|interior|exterior)\s+(space\s+)?(size|dimensions?)\b/i,
  /^package\s+(size|dimensions?|weight)\b/i,
  // Dimension with letter AFTER the number: "18.7"W x 18.3"D" (supplier raw format)
  /\b\d+(\.\d+)?\s*[""']?\s*[LWDHlwdh]\s*[xX×]/,
];

export function isUsableBullet(s: string): boolean {
  const t = s.trim();
  if (t.length < 12 || t.length > 180) return false;
  return !SKIP_BULLET_PATTERNS.some(re => re.test(t));
}

export function isUsableSentence(s: string): boolean {
  const trimmed = s.trim();
  if (trimmed.length < 15) return false;
  return !SKIP_DESC_PATTERNS.some(re => re.test(trimmed))
    && !SKIP_BULLET_PATTERNS.some(re => re.test(trimmed));
}
