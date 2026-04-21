/**
 * Source of truth: /NORMALIZATION_ENGINE.md
 * All product title, features, description, specifications, image, and family logic must follow this file.
 * Do NOT add UI-side cleaning or formatting logic.
 *
 * Generated review engine for Xself Home.
 *
 * Reviews are cold-start only. Every generated review is tagged:
 *   review_source = 'generated'  |  is_generated = true  |  display_priority >= 500
 *
 * Real reviews will use:
 *   review_source = 'real'  |  is_generated = false  |  display_priority = 10–100
 *
 * Phase-out path: filter WHERE is_generated = false in the product detail query.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type ReviewableProduct = {
  supplier_product_id: string;
  product_title_display?: string;
  product_title?: string;
  category_code?: string;
  key_features_json?: string[];
  short_description?: string;
  material?: string;
  dimensions?: string;
  color?: string;
  product_family_key?: string;
  specifications_json?: Record<string, string>;
};

export type ReviewCategory =
  | 'sofa' | 'sofa_bed' | 'loveseat' | 'ottoman'
  | 'dining_chair' | 'accent_chair' | 'office_chair' | 'stool'
  | 'cabinet' | 'sideboard' | 'pantry'
  | 'dresser' | 'nightstand'
  | 'bathroom_vanity'
  | 'coffee_table' | 'console_table' | 'dining_table' | 'desk'
  | 'bookshelf' | 'tv_stand' | 'pet_furniture' | 'fallback';

type ReviewTheme = 'room_fit' | 'practical_use' | 'comfort_usability' | 'value' | 'social_use';

export type GeneratedReview = {
  supplier_product_id: string;
  rating: number;
  title: string;
  body: string;
  reviewer_name: string;
  helpful_count: number;
  review_source: 'generated';
  is_generated: true;
  verified_purchase: false;
  status: 'active';
  display_priority: number;
  tags: string[];
};

// ── Deterministic seed ────────────────────────────────────────────────────────

function hash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0;
  }
  return h;
}

function pick<T>(arr: T[], seed: number, offset = 0): T {
  return arr[(seed + offset) % arr.length];
}

// ── Reviewer name pool ────────────────────────────────────────────────────────

const REVIEWER_NAMES = [
  'Sarah B.', 'Jason M.', 'Emily R.', 'Nicole P.', 'Linda T.',
  'Kevin H.', 'Rachel C.', 'Daniel S.', 'Melissa J.', 'Chris A.',
  'Tanya W.', 'Marcus L.', 'Jen F.', 'Dominic O.', 'Carla N.',
  'Brian E.', 'Priya K.', 'Tom G.', 'Alicia V.', 'Derek Y.',
];

export function buildReviewerName(seed: number, offset = 0): string {
  return pick(REVIEWER_NAMES, seed, offset);
}

// ── Category inference ────────────────────────────────────────────────────────

export function inferReviewCategory(product: ReviewableProduct): ReviewCategory {
  const title = (product.product_title_display ?? product.product_title ?? '').toLowerCase();
  const cat   = (product.category_code ?? '').toLowerCase();
  const feats = (product.key_features_json ?? []).join(' ').toLowerCase();
  const all   = `${title} ${cat} ${feats}`;

  if (/sofa\s+bed|sleeper\s+sofa|pull.out\s+sofa/i.test(all)) return 'sofa_bed';
  if (/loveseat|love\s+seat/i.test(all)) return 'loveseat';
  if (/ottoman|footstool|foot\s+rest/i.test(all)) return 'ottoman';
  if (/sofa|couch|sectional/i.test(all)) return 'sofa';
  if (/office\s+chair|desk\s+chair|task\s+chair|ergonomic\s+chair/i.test(all)) return 'office_chair';
  if (/accent\s+chair|arm\s+chair|armchair|lounge\s+chair|leisure\s+chair/i.test(all)) return 'accent_chair';
  if (/dining\s+chair|side\s+chair|rubberwood.*chair|chair.*dining/i.test(all)) return 'dining_chair';
  if (/bar\s+stool|counter\s+stool|\bstool\b/i.test(all)) return 'stool';
  if (/bathroom\s+vanity|vanity\s+cabinet|sink\s+cabinet|vessel\s+sink/i.test(all)) return 'bathroom_vanity';
  if (/kitchen\s+pantry|pantry\s+cabinet|pantry\s+cupboard/i.test(all)) return 'pantry';
  if (/sideboard|buffet\s+cabinet/i.test(all)) return 'sideboard';
  if (/litter\s+box|cat\s+house|pet\s+house|dog\s+crate|pet\s+enclosure/i.test(all)) return 'pet_furniture';
  if (/nightstand|bedside\s+table/i.test(all)) return 'nightstand';
  if (/dresser|chest\s+of\s+drawer|6.drawer|5.drawer|4.drawer/i.test(all)) return 'dresser';
  if (/tv\s+stand|media\s+console|media\s+stand|entertainment\s+center/i.test(all)) return 'tv_stand';
  if (/coffee\s+table/i.test(all)) return 'coffee_table';
  if (/console\s+table/i.test(all)) return 'console_table';
  if (/dining\s+table|kitchen\s+table/i.test(all)) return 'dining_table';
  if (/bookshelf|bookcase/i.test(all)) return 'bookshelf';
  if (/\bdesk\b/i.test(all)) return 'desk';
  if (/cabinet|cupboard|storage\s+cabinet/i.test(all)) return 'cabinet';

  // Fallback by category_code
  const cc = (product.category_code ?? '').toUpperCase();
  if (cc === 'SF') return 'sofa';
  if (cc === 'DR') return 'dresser';
  if (cc === 'NS') return 'nightstand';
  if (cc === 'CB') return 'cabinet';
  if (cc === 'SB') return 'sideboard';
  if (cc === 'CT') return 'coffee_table';
  if (cc === 'CO') return 'console_table';
  if (cc === 'TV') return 'tv_stand';
  if (cc === 'BK') return 'bookshelf';
  if (cc === 'DC') return 'dining_chair';
  if (cc === 'DK') return 'desk';
  if (cc === 'WR') return 'dresser';
  if (cc === 'BA') return 'bathroom_vanity';

  return 'fallback';
}

// ── Signal extraction ─────────────────────────────────────────────────────────

export type ReviewSignals = {
  room: string;
  colorPhrase: string;
  materialPhrase: string;
  productNoun: string;
};

const PRODUCT_NOUNS: Partial<Record<ReviewCategory, string>> = {
  sofa: 'sofa', sofa_bed: 'sofa bed', loveseat: 'loveseat', ottoman: 'ottoman',
  dining_chair: 'chair', accent_chair: 'chair', office_chair: 'chair', stool: 'stool',
  cabinet: 'cabinet', sideboard: 'sideboard', pantry: 'pantry cabinet',
  dresser: 'dresser', nightstand: 'nightstand',
  bathroom_vanity: 'vanity', coffee_table: 'coffee table',
  console_table: 'console table', dining_table: 'dining table', desk: 'desk',
  bookshelf: 'bookshelf', tv_stand: 'TV stand', pet_furniture: 'piece', fallback: 'piece',
};

function deriveColorPhrase(color: string): string {
  const c = color.toLowerCase();
  if (!c) return '';
  if (/white|ivory|cream/i.test(c)) return 'the white finish';
  if (/black/i.test(c)) return 'the black finish';
  if (/gray|grey|charcoal/i.test(c)) return 'the gray tone';
  if (/brown|espresso/i.test(c)) return 'the warm brown finish';
  if (/walnut/i.test(c)) return 'the walnut finish';
  if (/beige|sand/i.test(c)) return 'the warm neutral tone';
  if (/oak|natural/i.test(c)) return 'the natural wood finish';
  if (/navy|blue/i.test(c)) return 'the navy fabric';
  if (/green/i.test(c)) return 'the green upholstery';
  if (/linen/i.test(c)) return 'the linen tone';
  return `the ${c} finish`;
}

function deriveMaterialPhrase(material: string): string {
  const m = material.toLowerCase();
  if (!m) return '';
  if (/linen/i.test(m)) return 'linen fabric';
  if (/velvet/i.test(m)) return 'velvet upholstery';
  if (/fabric|polyester|microfiber/i.test(m)) return 'fabric upholstery';
  if (/leather|pu\s+leather|faux\s+leather/i.test(m)) return 'faux leather';
  if (/solid\s+wood|hardwood|rubberwood/i.test(m)) return 'solid wood frame';
  if (/mdf|particle\s*board|engineered\s*wood/i.test(m)) return 'engineered wood construction';
  if (/metal|steel|iron/i.test(m)) return 'metal frame';
  return m;
}

export function extractReviewSignals(product: ReviewableProduct, cat: ReviewCategory): ReviewSignals {
  const all = `${product.product_title_display ?? product.product_title ?? ''} ${(product.key_features_json ?? []).join(' ')}`.toLowerCase();

  let room = 'home';
  if (/bedroom|dresser|nightstand|wardrobe/i.test(all)) room = 'bedroom';
  else if (/living\s*room|sofa|coffee\s+table|tv\s+stand|console/i.test(all)) room = 'living room';
  else if (/dining|sideboard|buffet/i.test(all)) room = 'dining room';
  else if (/bathroom|vanity/i.test(all)) room = 'bathroom';
  else if (/office|desk|workspace/i.test(all)) room = 'home office';
  else if (/entryway|hallway|foyer/i.test(all)) room = 'entryway';
  else if (/kitchen|pantry/i.test(all)) room = 'kitchen';

  return {
    room,
    colorPhrase: deriveColorPhrase(product.color ?? ''),
    materialPhrase: deriveMaterialPhrase(product.material ?? ''),
    productNoun: PRODUCT_NOUNS[cat] ?? 'piece',
  };
}

// ── Language banks ────────────────────────────────────────────────────────────

type ThemeBlock = {
  titles: string[];
  openings: string[];
  middles: string[];
  closings: string[];
  reservations: string[]; // used only on 4-star reviews
};

type CategoryBank = Record<ReviewTheme, ThemeBlock>;

const BANKS: Partial<Record<ReviewCategory, CategoryBank>> & { fallback: CategoryBank } = {

  sofa: {
    room_fit: {
      titles: ['Changed how the living room felt immediately', 'Proportions work really well for our layout', 'Better in person than in the product photos', 'Works with the room rather than against it'],
      openings: ['This sofa changed how our living room felt immediately.', 'We were a little nervous about the scale but it fits perfectly.', 'The proportions work really well for our open layout.'],
      middles: ['The low profile keeps the room from feeling too heavy.', 'It anchors the seating area without overwhelming the space.', 'Color reads slightly warmer in person which we actually prefer.'],
      closings: ['Would recommend for anyone looking for something that looks elevated without trying too hard.', 'Happy with how much it improved the room.'],
      reservations: ['Looks great in the room and does what we needed — color was a touch lighter than the photos, though it still works well.'],
    },
    practical_use: {
      titles: ['Still looks the same after months of daily use', 'Holds its shape better than I expected', 'Good everyday sofa without any fuss'],
      openings: ['We use this sofa every day and it still looks and feels like it did when it arrived.', "We've had it for a few months and the shape has held up well."],
      middles: ['The seat depth is generous enough to actually relax without sliding forward.', 'The frame feels solid — no creaking or shifting when multiple people sit down.'],
      closings: ['Good everyday sofa that does what it needs to do.', 'Solid choice if you want comfort without fussing too much.'],
      reservations: ['The back cushions flatten a little faster than I expected — worth refluffing periodically, but holds up well otherwise.'],
    },
    comfort_usability: {
      titles: ['Comfortable for a long evening without shifting', 'Broke in faster than expected', 'More comfortable once you actually sit in it'],
      openings: ['The seat cushions have the right amount of give — not too soft, not too firm.', 'I was worried it might feel stiff but it broke in faster than expected.'],
      middles: ['Spent a few hours on it watching a film and felt comfortable the whole time.', 'The back support is solid for a fabric sofa at this price point.'],
      closings: ['Good comfort level for everyday living room use.', 'Comfortable for long evenings and easy to clean.'],
      reservations: ['Comfortable from the start — slightly firm at first, but noticeably better after a few weeks of regular use.'],
    },
    value: {
      titles: ['More solid than I expected at this price', 'Looks higher-end than the cost suggests', 'Hard to find this quality at this price point'],
      openings: ['For the price, this sofa looks and feels more expensive than it is.', 'I compared several sofas at this price point and this one seemed better put together.'],
      middles: ['The stitching and upholstery feel clean and tight, which usually matters long-term.'],
      closings: ['Happy with the purchase and would buy again.', 'Good value overall.'],
      reservations: ['Really happy with it overall — just a few minor seam details I notice up close, nothing visible from a normal distance.'],
    },
    social_use: {
      titles: ['Became the main gathering spot in our apartment', 'Good scale for a smaller living room', 'Works well when people come over'],
      openings: ["We host fairly often and guests always end up on this sofa.", "It's become the main gathering spot in our apartment."],
      middles: ['Works great for movie nights — enough room for two people to sit comfortably with space.', 'Pulls the living room together as a proper seating area.'],
      closings: ['Would absolutely recommend for anyone with a social home.'],
      reservations: ['Great everyday and entertaining sofa — could be a bit deeper for fully lying down, but that was never the main use case.'],
    },
  },

  sofa_bed: {
    room_fit: {
      titles: ['Looks like a real sofa', 'Fits the space better than expected', 'Cleaner look than most sofa beds'],
      openings: ["This doesn't read as a 'sofa bed' from across the room, which was the whole point.", 'The silhouette is clean enough that guests never guess it converts.'],
      middles: ['Scale works well in a smaller living room without making it feel cramped.', 'The frame looks solid and the proportions are right for a studio layout.'],
      closings: ['Happy with how it looks and functions in one.'],
      reservations: ['Slightly bulkier than a standard sofa but expected given the convertible mechanism.'],
    },
    practical_use: {
      titles: ['Guest setup works well', 'Easier to convert than expected', 'Good dual-purpose piece'],
      openings: ['The pull-out mechanism is smoother than a few other sofa beds I have tried.', 'Setting it up for overnight guests takes about two minutes.'],
      middles: ['The sleeping surface is wide enough for one adult comfortably.', 'Works as both a sofa and a proper sleeping option without being bulky.'],
      closings: ['Solved our guest room problem in a one-bedroom apartment.'],
      reservations: ['The mattress is on the thinner side — a topper helps for longer stays.'],
    },
    comfort_usability: {
      titles: ['Comfortable on both settings', 'Good for guests', 'Practical and comfortable'],
      openings: ['As a sofa it sits comfortably and the cushions feel solid.', "My guests slept fine on it — no complaints the morning after."],
      middles: ['The seat cushions work both when sitting and lying down.', "It's not the most luxurious sleeping surface but totally acceptable for guests."],
      closings: ['Good balance of sofa comfort and guest bed function.'],
      reservations: ['As a sofa the back cushions are a touch firm but manageable.'],
    },
    value: {
      titles: ['Great for the price', 'Worth it for a studio', 'Good value dual-purpose'],
      openings: ['Getting a sofa and a guest bed in one piece at this price is hard to argue with.'],
      middles: ['Quality is solid enough that it feels like a real piece of furniture.'],
      closings: ['Would recommend for anyone in a smaller space.'],
      reservations: ['Takes some space to fully open but comes with the territory.'],
    },
    social_use: {
      titles: ['Solves the guest room problem', 'Perfect for smaller spaces', 'Great for apartment living'],
      openings: ["We live in a one-bedroom and this was the right solution for overnight guests.", "I've had people stay several nights and no complaints."],
      middles: ['Works perfectly in a space where a dedicated guest room isn\'t possible.'],
      closings: ['Practical and looks good for an apartment living room.'],
      reservations: ['Not quite a full guest bed experience but gets the job done.'],
    },
  },

  loveseat: {
    room_fit: {
      titles: ['Perfect size for the room', 'Fits our smaller space well', 'Nice scale for a loveseat'],
      openings: ['We needed something smaller than a full sofa and this is exactly the right scale.', 'The size is just right for our apartment living area.'],
      middles: ['Looks balanced in a smaller room without making it feel overwhelmed.', 'The proportions work well next to our larger accent chair.'],
      closings: ['Would recommend for smaller living areas.'],
      reservations: ['Could be slightly deeper for lounging but great as seating.'],
    },
    practical_use: {
      titles: ['Comfortable daily seating', 'Good everyday piece', 'Works well for two people'],
      openings: ['This is our main seating and we use it every day.', 'Fits two adults comfortably and holds its shape well.'],
      middles: ['Seat cushions have stayed firm after a few months of daily use.', 'Easy to sit in and get out of — the height is just right.'],
      closings: ['Solid everyday seating piece.'],
      reservations: ['Not much room for lounging sideways but fine for two sitting comfortably.'],
    },
    comfort_usability: {
      titles: ['Comfortable enough for extended use', 'Good support', 'Nice for an evening at home'],
      openings: ['The cushions are supportive without feeling too rigid.', 'Comfortable for a few hours of sitting without getting fatigued.'],
      middles: ['Back support feels solid and the cushions hold their shape.'],
      closings: ['Good everyday comfort.'],
      reservations: ['Could be a little deeper for true lounging.'],
    },
    value: {
      titles: ['Better fabric and build than I expected at this price', 'Reads as more expensive than what we paid', 'The right quality for the budget we had'],
      openings: ['The fabric looks and feels better than the price suggests.'],
      middles: ['Build quality is solid — no wobble or squeak after months of use.'],
      closings: ['Good purchase for a smaller living area.'],
      reservations: ['A couple minor finish details but nothing visible from everyday distance.'],
    },
    social_use: {
      titles: ['Good for small spaces', 'Works for a studio', 'Right size for an apartment'],
      openings: ["We live in a studio and this was the right call over a full sofa.", "It fits two people comfortably and doesn't eat the whole room."],
      middles: ['Scale feels intentional rather than like a compromise.'],
      closings: ['Great choice for smaller spaces.'],
      reservations: ['Obviously can\'t seat more than two, but that\'s the point.'],
    },
  },

  ottoman: {
    room_fit: {
      titles: ['Finishes the seating area', 'Works as a coffee table too', 'Nice piece for the living room'],
      openings: ['This ottoman ties the whole seating area together.', 'We use it as both a footrest and a casual coffee table.'],
      middles: ['The scale is right — not too big, and height matches our sofa well.', 'Looks intentional rather than an afterthought in the room.'],
      closings: ['A versatile piece that earns its floor space.'],
      reservations: ['Wish the surface was a bit firmer for using as a table.'],
    },
    practical_use: {
      titles: ['More useful than expected', 'Gets used constantly', 'Great for everyday use'],
      openings: ["We use this more than I expected.", 'Doubles as extra seating, footrest, and surface all in one.'],
      middles: ['The size is generous enough to be practical without crowding the room.'],
      closings: ['One of the more versatile purchases we\'ve made.'],
      reservations: ['Fabric shows marks a little easily but cleans up fine.'],
    },
    comfort_usability: {
      titles: ['Comfortable to put your feet up', 'Good firmness', 'Comfortable everyday piece'],
      openings: ['The firmness is just right — solid enough to use as a surface but comfortable underfoot.', 'Put my feet up on this after work every day and it holds up great.'],
      middles: ['The padding keeps its shape and doesn\'t sink too much with use.'],
      closings: ['Good everyday comfort level.'],
      reservations: ['A bit firm for using as a seat but fine as a footrest.'],
    },
    value: {
      titles: ['More substantial in person than the price suggests', 'Solid build that earns its place in the room', 'Looks like it cost more than it did'],
      openings: ['Looks more substantial in person than the price suggests.'],
      middles: ['Construction feels solid and the upholstery is tight with no loose stitching.'],
      closings: ['Good value for a living room essential.'],
      reservations: ['Could have a tray on top included but that\'s easy to add separately.'],
    },
    social_use: {
      titles: ['Extra seating when needed', 'Great for entertaining', 'Works for movie nights'],
      openings: ['This doubles as extra seating when we have people over.', 'We use it as a footrest normally but it works as a seat for extra guests.'],
      middles: ['Easy to move around without being too heavy.'],
      closings: ['A practical dual-use living room piece.'],
      reservations: ['Not the most comfortable seating but totally fine for shorter periods.'],
    },
  },

  dining_chair: {
    room_fit: {
      titles: ['Looks great around the table', 'Works well in the dining room', 'Good visual weight'],
      openings: ['These chairs look exactly right around our table.', 'The design works with a lot of different table styles — we were glad it clicked with ours.'],
      middles: ['The profile is clean enough not to visually clutter the room.', 'Scale feels right and the proportions are balanced.'],
      closings: ['Would recommend for anyone looking for a clean dining chair that goes with multiple styles.'],
      reservations: ['Color was slightly different from photos but looks good in the room.'],
    },
    practical_use: {
      titles: ['Comfortable for meals', 'Works well for daily dining', 'Solid everyday chair'],
      openings: ['We sit in these for every meal and they hold up well.', "Comfortable enough for a full dinner without wanting to leave early."],
      middles: ['The seat height works well with our dining table.', 'Frame feels solid — no wobble or flex under normal use.'],
      closings: ['A reliable dining chair that does its job without any fuss.'],
      reservations: ['The seat cushion could be a touch thicker for longer meals.'],
    },
    comfort_usability: {
      titles: ['Comfortable back support', 'Good for long dinners', 'Sits well'],
      openings: ['The back support is better than I expected for a dining chair at this price.', "We've had long dinner parties and these stayed comfortable throughout."],
      middles: ['The seat feels firm enough to be supportive without being uncomfortable.', 'Back angle is well-designed — not too upright, not too reclined.'],
      closings: ['Good everyday dining comfort.'],
      reservations: ['A little firm compared to upholstered chairs but normal for this style.'],
    },
    value: {
      titles: ['Good value for a set', 'Quality for the price', 'Solid chairs for the money'],
      openings: ['Buying a set of four at this price felt like a risk, but these exceeded expectations.', 'For the price, these are well-made and look higher-end than the cost.'],
      middles: ['The joints feel tight and the finish is clean.'],
      closings: ['Would buy these again.'],
      reservations: ['Assembly took a bit longer than expected but the end result is solid.'],
    },
    social_use: {
      titles: ['Pull the dining room together as a matching set', 'People notice when the dining setup is cohesive', 'Our dinner parties look more intentional now'],
      openings: ['We entertain regularly and these chairs get a lot of use.', "Having a matching set made the dining area feel properly finished."],
      middles: ['Having a matching set of four pulls the dining area together.', 'They look intentional and elevated for the price point.'],
      closings: ['Great set for a dining room that gets real use.'],
      reservations: ['Would like a set of six option for larger gatherings.'],
    },
  },

  accent_chair: {
    room_fit: {
      titles: ['Adds something to the room', 'Good accent for the space', 'Looks great in the corner'],
      openings: ['This chair is exactly what the corner of our living room needed.', 'It adds the right amount of visual interest without competing with the sofa.'],
      middles: ['The scale is right for an accent chair — substantial but not dominating.', 'Color reads well in the space and works with our existing palette.'],
      closings: ['Great finishing touch for a living room layout.'],
      reservations: ['Took a moment to find the right placement but looks great once settled.'],
    },
    practical_use: {
      titles: ['More useful than decorative', 'Gets used daily', 'Good reading chair'],
      openings: ['This is our go-to reading spot now.', "We have it next to a lamp and it's become the favorite seat in the house."],
      middles: ['Comfortable enough for an hour of reading without feeling the need to move.'],
      closings: ['A practical accent chair that earns its spot.'],
      reservations: ['Not deep enough for lounging sideways but great for upright sitting.'],
    },
    comfort_usability: {
      titles: ['Comfortable to sit in', 'Good everyday chair', 'Nice to spend time in'],
      openings: ['The cushioning has a nice firmness that feels supportive for extended sitting.', "More comfortable than it looks — which was a pleasant surprise."],
      middles: ['Arm height is practical and the seat back is the right angle.'],
      closings: ['Comfortable enough for regular everyday use.'],
      reservations: ['Could be slightly deeper but the proportions are right for the style.'],
    },
    value: {
      titles: ['Looks more expensive', 'Quality for the price', 'Good value accent chair'],
      openings: ['Looks much more expensive in person than the price suggests.'],
      middles: ['Upholstery is tight and the frame feels solid with no wobble.'],
      closings: ['Very happy with the quality and the look.'],
      reservations: ['A few stitching details could be neater but not visible in everyday use.'],
    },
    social_use: {
      titles: ['Everyone who visits ends up in this chair', 'Became the focal point of the living room', 'Adds real seating variety to the space'],
      openings: ['Every guest who comes over gravitates toward this chair.', "It draws attention without trying to — just a clean, confident piece."],
      middles: ['Adds visual variety to the room without competing with the sofa.'],
      closings: ['A great addition to a sociable living space.'],
      reservations: ['Only fits one, obviously, but that\'s the point.'],
    },
  },

  office_chair: {
    room_fit: {
      titles: ['Looks professional at home', 'Fits the home office well', 'Clean look for a desk setup'],
      openings: ['Finally a desk chair that looks like it belongs in a home office instead of a cubicle.', 'This works visually with a home setup without being purely utilitarian.'],
      middles: ['The profile is clean and it photographs well on video calls.', 'Fits our desk area without feeling too office-park.'],
      closings: ['Would recommend for anyone working from home.'],
      reservations: ['Could be slightly lower profile but works well in our space.'],
    },
    practical_use: {
      titles: ['Good for all-day use', 'Works well for long sessions', 'Practical home office chair'],
      openings: ["I work from home and sit in this for 6–8 hours most days.", "I've tried a few chairs in this range and this one holds up best for full days."],
      middles: ['The lumbar support makes a noticeable difference by mid-afternoon.', 'Adjustments work correctly and hold throughout the day.'],
      closings: ['Good everyday work chair that doesn\'t get in the way.'],
      reservations: ['Cushion is slightly firm at first but broke in after a week or two.'],
    },
    comfort_usability: {
      titles: ['Good lumbar support', 'Comfortable for long sessions', 'Holds up to extended use'],
      openings: ['Back felt noticeably better after switching to this chair.', "The lumbar support is positioned right — that's not always the case."],
      middles: ['Seat cushion stays comfortable through a full workday.', 'Height adjustment range is wide enough to work with most desks.'],
      closings: ['Good everyday work comfort.'],
      reservations: ['Armrest height isn\'t fully adjustable but the position works for most setups.'],
    },
    value: {
      titles: ['Worth the step up from cheaper chairs', 'Built to last longer than the price implies', 'Paid more than entry-level and felt the difference immediately'],
      openings: ['I went through two cheaper chairs before this one and the difference in quality is clear.'],
      middles: ['Build quality is solid — no creaking or loosening after months of use.'],
      closings: ['Worth spending a bit more for something that lasts.'],
      reservations: ['Assembly instructions could be clearer but the result is sturdy.'],
    },
    social_use: {
      titles: ['Doubles as extra seating', 'Works for video calls', 'Practical beyond the desk'],
      openings: ["It's our main desk chair but also gets used as extra seating when people are over.", 'Looks professional on video calls — colleagues have asked about it.'],
      middles: ['Clean enough to work in multiple contexts without looking out of place.'],
      closings: ['A versatile piece for a home that doubles as a workspace.'],
      reservations: ['Could use a slight headrest option but not essential.'],
    },
  },

  stool: {
    room_fit: {
      titles: ['Right height for the counter', 'Looks good in the kitchen', 'Good fit for a kitchen island'],
      openings: ['The height works perfectly with our kitchen island — finally got that right.', 'These look clean and modern next to our counter.'],
      middles: ['The profile is slim enough to tuck under the counter when not in use.', 'Scale is right and they don\'t crowd the kitchen.'],
      closings: ['Good practical addition to a kitchen with an island.'],
      reservations: ['Height was slightly taller than expected but works out fine.'],
    },
    practical_use: {
      titles: ['Stable for daily use', 'Easy to tuck away', 'Works well as a counter seat'],
      openings: ['We use these every morning for breakfast and they hold up to daily use.', 'Sit at the counter for quick meals and these are exactly what was needed.'],
      middles: ['Easy to pull out and tuck back in without scratching the floor.', 'Footrest is at the right height for comfortable sitting.'],
      closings: ['A practical everyday counter stool.'],
      reservations: ['Could use a slight cushion but works fine for shorter meals.'],
    },
    comfort_usability: {
      titles: ['Comfortable for a quick meal without thinking about it', 'Footrest is at exactly the right height', 'Sits level and stable every time'],
      openings: ['Comfortable for breakfast or a quick lunch — not a lounging chair but right for the use case.'],
      middles: ['Footrest height is well-placed and the seat is firm in a good way.'],
      closings: ['Good everyday counter stool comfort.'],
      reservations: ['Not quite comfortable enough for hour-long sitting but right for meals.'],
    },
    value: {
      titles: ['More solid than expected as a set purchase', 'Better build than we anticipated at this price', 'A clean look for a practical price'],
      openings: ['Bought a set of three and the price-to-quality ratio is good.'],
      middles: ['Construction feels solid with no wobble under normal use.'],
      closings: ['Would recommend.'],
      reservations: ['Minor finish imperfections on close inspection but not visible in use.'],
    },
    social_use: {
      titles: ['Great for casual hosting', 'Kitchen island seating sorted', 'Works for a crowd'],
      openings: ['We entertain at the kitchen island and these work great for that.'],
      middles: ['Easy for guests to pull up and the set of three feels intentional.'],
      closings: ['Good for a social kitchen setup.'],
      reservations: ['Could seat more if we had a longer island but three is right for ours.'],
    },
  },

  cabinet: {
    room_fit: {
      titles: ['Cleaned up the room without adding visual weight', 'Works better in person than in the photos', 'Fills the wall without making the room feel heavy'],
      openings: ['The closed doors make such a difference — the room immediately looks more organized.', 'We placed this in the living room and it looks completely intentional there.'],
      middles: ['The height and width proportion feels right — it doesn\'t dominate the wall.', 'The finish is cleaner in person than in the photos.'],
      closings: ['A great addition to any room that needs both storage and a clean look.'],
      reservations: ['Really happy with how it looks — the hardware is a little plain, but easy to replace if you want more visual character.'],
    },
    practical_use: {
      titles: ['Solved our living room clutter problem', 'More storage inside than it looks from outside', 'Everything hidden and still easy to find'],
      openings: ['We had so much loose clutter and this solved it immediately.', 'Everything that used to live on open shelves is now behind these doors.'],
      middles: ['The interior layout is practical — adjustable shelving made it flexible for what we actually store.', 'Doors close flush and stay closed, which matters more than it sounds.'],
      closings: ['Room feels significantly cleaner with this in it.'],
      reservations: ['Holds everything we needed — just note that interior dimensions are smaller than exterior measurements suggest, so measure your items first.'],
    },
    comfort_usability: {
      titles: ['Hinges feel solid and the doors close cleanly', 'Opens and closes exactly as it should every time', 'Daily use confirmed it\'s well-built'],
      openings: ['The doors open smoothly and close properly — basic but worth noting.', 'Hardware feels more substantial than expected and the hinges are tight.'],
      middles: ['Easy to access what\'s inside and the shelves are at practical heights.'],
      closings: ['Works reliably without any complaints.'],
      reservations: ['Solid piece all around — assembly took longer than the estimate, but it\'s sturdy and well-built once together.'],
    },
    value: {
      titles: ['More substantial than the price suggested', 'Looks like it belongs with more expensive pieces', 'Better quality than we expected at this price'],
      openings: ['The finish and build quality surprised us for the price point.', 'Better looking in person and the construction quality surprised us.'],
      middles: ['For what you get — the size, the storage, and the look — the value is hard to beat.'],
      closings: ['Very happy with this purchase.'],
      reservations: ['Great value overall — a few minor assembly tolerances that disappear once it\'s built, nothing that affects the finished piece.'],
    },
    social_use: {
      titles: ['Keeps the room looking clean with almost no effort', 'Everything disappears before guests arrive', 'The room is tidy whenever we need it to be'],
      openings: ['This is how we keep our living room looking clean when people come over.', 'The room went from perpetually cluttered to always presentable.'],
      middles: ['Everything goes inside before company arrives — quick and effective.'],
      closings: ['A great investment for a tidy-looking home.'],
      reservations: ['Works exactly as intended — no display surface on top, but keeping things out of sight was always the point.'],
    },
  },

  sideboard: {
    room_fit: {
      titles: ['The dining room finally has a proper anchor', 'Scale is right for the wall behind our table', 'Changed how the whole dining room feels'],
      openings: ['This sideboard changed the whole feel of our dining room.', 'The horizontal scale is exactly right for the wall behind our dining table.'],
      middles: ['It adds weight to the room in a good way — the space felt unfinished before.', 'The finish pairs well with a lot of different wood tones.'],
      closings: ['A real room anchor that I\'d buy again.'],
      reservations: ['Great piece — it\'s heavy, so having two people for placement is definitely needed.'],
    },
    practical_use: {
      titles: ['The top surface alone makes it worth it', 'Table linens, serving platters, and cutlery all have a home', 'Everything for entertaining in one organized spot'],
      openings: ['We use the top surface constantly — it\'s the staging area for everything after a meal.', 'Stores our table linens, serving platters, and extra place settings perfectly.'],
      middles: ['The drawer handles cutlery and the cabinets take care of everything else.', 'Everything we need for hosting is now in one organized spot.'],
      closings: ['One of the most used pieces of furniture we own.'],
      reservations: ['Really useful piece — drawers could be a bit deeper for bulkier items, but they handle everything we actually need to store.'],
    },
    comfort_usability: {
      titles: ['Drawers slide smoothly every time', 'Doors feel solid and close cleanly', 'Works exactly as you\'d want for daily dining use'],
      openings: ['The drawers slide smoothly and the cabinet doors feel solid.', 'Hardware has a quality feel and the doors close with satisfying resistance.'],
      middles: ['Easy to pull out exactly what you need without fuss.'],
      closings: ['Works reliably as a daily-use piece.'],
      reservations: ['Works well for daily use — one drawer needed minor adjustment out of the box, but an easy fix.'],
    },
    value: {
      titles: ['Looks much pricier than what we paid', 'Surprised us with the quality for the cost', 'A genuinely good dining room investment'],
      openings: ['This looks like it cost two or three times what we paid.', 'The finish and proportions read significantly more premium than the price.'],
      middles: ['The proportions and finish quality give it a much more premium appearance.'],
      closings: ['Excellent value for a dining room centerpiece.'],
      reservations: ['Great value overall — took a couple of hours to assemble, but the end result reads as a much more expensive piece.'],
    },
    social_use: {
      titles: ['Made dinner parties feel more organized', 'The dining room looks finished before guests arrive', 'The staging surface we didn\'t know we needed'],
      openings: ['We entertain regularly and this piece was designed for exactly that.', 'Dinner parties are so much easier with a dedicated serving and storage surface.'],
      middles: ['Everything we need for a dinner party is organized and accessible.', 'The top becomes a staging area for serving dishes and drinks before they go to the table.'],
      closings: ['Transformed how we entertain.'],
      reservations: ['Great for hosting — could use one more interior shelf for larger gatherings, but it handles everything we need right now.'],
    },
  },

  pantry: {
    room_fit: {
      titles: ['Looks clean in the kitchen', 'Fits the space well', 'Tidy kitchen addition'],
      openings: ['This pantry cabinet fits our kitchen layout perfectly and looks intentional there.', "The doors keep everything out of sight, which is exactly what our kitchen needed."],
      middles: ['The scale fills the wall nicely without blocking walkways.', 'Clean exterior makes the kitchen look more organized just by being there.'],
      closings: ['Great kitchen storage addition.'],
      reservations: ['Slightly trickier assembly than expected but solid once done.'],
    },
    practical_use: {
      titles: ['Finally real kitchen storage', 'Everything fits now', 'Great pantry solution'],
      openings: ['We\'ve needed more kitchen storage for years and this solved it.', 'Pantry staples, appliances, and snacks all have a home now.'],
      middles: ['The shelving configuration works well for our mix of tall and short items.', 'Doors close cleanly and keep everything concealed.'],
      closings: ['A practical kitchen storage solution that I\'d recommend.'],
      reservations: ['Some shelves could be slightly deeper but still very useful.'],
    },
    comfort_usability: {
      titles: ['Easy to access daily', 'Shelving works well', 'Functional everyday piece'],
      openings: ['Everything is easy to see and reach — well-thought-out interior.', 'The door storage adds extra capacity for spices and small items.'],
      middles: ['Practical to use daily and holds more than the exterior suggests.'],
      closings: ['A great everyday pantry cabinet.'],
      reservations: ['Would like slightly taller shelf spacing for larger bottles.'],
    },
    value: {
      titles: ['Great storage value', 'Looks like it costs more', 'Good purchase for the kitchen'],
      openings: ['For the storage you get, the price is very reasonable.'],
      middles: ['Looks much better in the kitchen than a wire rack or open shelving.'],
      closings: ['Happy with the purchase.'],
      reservations: ['Assembly was a process but the end result is solid.'],
    },
    social_use: {
      titles: ['Kitchen stays tidy for company', 'Helpful for a busy household', 'Works great for a family'],
      openings: ['With kids in the house, having all the snacks and pantry items behind closed doors is essential.', 'Kitchen looks clean when guests come over — all the visual clutter is inside.'],
      middles: ['Works well for a busy household where multiple people are in the kitchen daily.'],
      closings: ['A practical addition to a family kitchen.'],
      reservations: ['Could use a lower section for kids to access but that\'s a personal preference.'],
    },
  },

  dresser: {
    room_fit: {
      titles: ['Bedroom looks much better', 'Right scale for the wall', 'Ties the bedroom together'],
      openings: ['This dresser immediately made our bedroom feel more pulled together.', 'We\'d been using a freestanding wardrobe and this is a much better fit for the room.'],
      middles: ['The scale fills the wall without overwhelming the space.', 'Finish pairs well with our existing bed frame.'],
      closings: ['A real bedroom improvement.'],
      reservations: ['Top surface scratches relatively easily — worth using a tray or mat.'],
    },
    practical_use: {
      titles: ['Drawers are useful every day', 'Solved our clothing storage problem', 'Practical bedroom organizer'],
      openings: ['We used to have overflow clothing everywhere — this fixed that.', 'Six drawers gives us way more flexibility than our old setup.'],
      middles: ['The drawer depth is practical — can actually fold and stack clothes properly.', 'We\'ve had it for months and the drawers still glide smoothly.'],
      closings: ['A bedroom essential that actually works.'],
      reservations: ['Bottom drawer is a little hard to reach but workable.'],
    },
    comfort_usability: {
      titles: ['Drawers work well', 'Smooth operation daily', 'Good build for everyday use'],
      openings: ['The drawers open and close smoothly — that matters more than it sounds over years of daily use.', 'Build quality feels solid and the drawers haven\'t loosened over time.'],
      middles: ['Handles are easy to grip and the drawer stops prevent pulling too far.'],
      closings: ['A well-made everyday dresser.'],
      reservations: ['Drawers have a slight weight to them which is actually a good sign of solid build.'],
    },
    value: {
      titles: ['Reads as more expensive than the receipt says', 'Better looking and more solid than we expected at this price', 'A bedroom upgrade that didn\'t break the budget'],
      openings: ['Better looking and more solid than expected at this price.', 'Reads as significantly more expensive than it was — the finish quality makes the difference.'],
      middles: ['The finish is clean and the proportions look premium.'],
      closings: ['Great bedroom upgrade for the price.'],
      reservations: ['A couple of minor assembly details but nothing that shows in the final product.'],
    },
    social_use: {
      titles: ['The bedroom finally looks properly furnished', 'Works well in a guest bedroom too', 'Guests always comment on how organized the room feels'],
      openings: ['We finally have a proper bedroom that doesn\'t look thrown together.', 'Also put one in the guest bedroom — guests mention how put-together the room feels.'],
      middles: ['Having real bedroom furniture makes the whole space feel more intentional.'],
      closings: ['Would recommend for anyone looking to properly furnish a bedroom.'],
      reservations: ['Top needed a few minor touch-ups to look perfect but manageable.'],
    },
  },

  nightstand: {
    room_fit: {
      titles: ['Right height next to the bed', 'Looks balanced in the room', 'Good bedside piece'],
      openings: ['Height is exactly right for our bed — surface falls exactly where it should.', 'Looks balanced and proportional next to our bed frame.'],
      middles: ['The size is right — big enough to be useful but compact enough not to crowd the space.', 'Finish matches our dresser better than expected.'],
      closings: ['A good bedside piece that works as it should.'],
      reservations: ['Surface is a little smaller than expected but everything we need fits.'],
    },
    practical_use: {
      titles: ['Everything within reach', 'Practical bedside setup', 'Drawer is just the right size'],
      openings: ['Phone, charger, book, and water glass — all fits.', 'Drawer is exactly deep enough for the things you actually reach for at night.'],
      middles: ['Open shelf underneath is useful for a book or extra items.', 'No more reaching to the floor or piling things on the mattress.'],
      closings: ['Does exactly what a nightstand should.'],
      reservations: ['Could use a second drawer but the one drawer handles the basics.'],
    },
    comfort_usability: {
      titles: ['Easy to use every day', 'Works well for the purpose', 'Practical surface height'],
      openings: ['Surface height is just right — not too high to reach from lying down.', 'Drawer opens without pulling the nightstand forward.'],
      middles: ['Small footprint means it doesn\'t crowd the bed but still has useful surface space.'],
      closings: ['A practical, well-proportioned nightstand.'],
      reservations: ['Slightly lightweight which makes it easy to bump — might want to anchor it.'],
    },
    value: {
      titles: ['Good value for a bedside piece', 'Looks clean for the price', 'Quality bedside piece'],
      openings: ['Bought two and the pair looks intentional and well-matched.', 'Better looking and better built than expected for the price.'],
      middles: ['Finish is clean with no visible flaws from standing distance.'],
      closings: ['Solid value for a bedroom essential.'],
      reservations: ['Minor variation in finish between the two — not noticeable in the room.'],
    },
    social_use: {
      titles: ['Guest bedroom essential', 'Good for both sides of the bed', 'Easy to match as a pair'],
      openings: ['Got two of these for the guest bedroom — they work perfectly as a matching set.', 'Easy to buy two that match, which isn\'t always the case at this price.'],
      middles: ['Guests have a proper place to put their things now.'],
      closings: ['A good practical addition to any bedroom.'],
      reservations: ['Could include a USB charging port but that\'s becoming standard everywhere now.'],
    },
  },

  bathroom_vanity: {
    room_fit: {
      titles: ['Upgraded the whole bathroom in one piece', 'Looks finished under the mirror — finally', 'The bathroom feels like a different room now'],
      openings: ['Installing this vanity changed the entire feel of our bathroom.', 'It fits under our existing mirror perfectly and the proportions are just right.'],
      middles: ['The hardware looks high-end and the finish is consistent with no visible seams.', 'Everything reads more polished and coordinated now.'],
      closings: ['One of the better home upgrades we\'ve made.'],
      reservations: ['Great transformation overall — installation took longer than expected, but the result is really worth it.'],
    },
    practical_use: {
      titles: ['Cleared the countertop completely for the first time', 'Morning routine is noticeably smoother now', 'More under-sink storage than we\'ve ever had'],
      openings: ['Under-sink storage changed our morning routine completely.', 'We went from counter clutter to everything organized in one place.'],
      middles: ['Drawer layout is practical — deep enough for everyday items and divided sensibly.', 'The cabinet underneath holds far more than expected.'],
      closings: ['A genuinely useful bathroom improvement.'],
      reservations: ['Genuinely useful upgrade — one shelf had to go around the plumbing, but there\'s still plenty of well-organized storage.'],
    },
    comfort_usability: {
      titles: ['Soft-close drawers make it feel more premium than the price', 'Everything opens and closes reliably after months of daily use', 'Hardware feels more substantial than the price suggests'],
      openings: ['The drawer soft-close feature is a small detail that makes the whole piece feel premium.', 'Hardware has a substantial feel — nothing flimsy or loose.'],
      middles: ['Everything is easy to reach and the cabinet below stores everything without digging.'],
      closings: ['Practical and well-built for a daily-use bathroom piece.'],
      reservations: ['Works really well for daily use — sink connection required a plumber, which is standard for vanities but worth budgeting for.'],
    },
    value: {
      titles: ['Looks like a real renovation for what we paid', 'People assume we redid the whole bathroom', 'Hard to get this look for this price anywhere else'],
      openings: ['People think we did a full bathroom renovation — it was just the vanity.', 'Looks significantly more expensive than what we paid.'],
      middles: ['The quality of the finish and hardware makes it look like a designer purchase.'],
      closings: ['Best value upgrade we\'ve made to the house.'],
      reservations: ['Really impressive for the price — mirror isn\'t included, which adds to the total cost, but that\'s standard for vanities.'],
    },
    social_use: {
      titles: ['The bathroom feels like we actually renovated it', 'Every guest ends up saying something about the bathroom', 'Even a small bathroom feels intentional with the right vanity'],
      openings: ['The bathroom was the one room nobody ever commented on — that changed.', 'Even a small bathroom feels properly finished with this vanity.'],
      middles: ['Makes a rental or older bathroom feel renovated without a full remodel.'],
      closings: ['Highly recommend for anyone upgrading a bathroom on a budget.'],
      reservations: ['Great result for a smaller bathroom — installation was tight in our space, but manageable and definitely worth it.'],
    },
  },

  coffee_table: {
    room_fit: {
      titles: ['Anchors the seating area', 'Right scale for the sofa', 'Good living room centerpiece'],
      openings: ['This coffee table ties the seating area together better than anything else we tried.', 'The scale is proportional to our sofa — not too small to get lost, not too large.'],
      middles: ['The surface height is exactly right from the sofa.', 'Finish works with both light and dark room palettes.'],
      closings: ['A well-proportioned living room centerpiece.'],
      reservations: ['Surface shows fingerprints easily but wipes clean.'],
    },
    practical_use: {
      titles: ['Gets used constantly', 'Practical everyday surface', 'The right table for the room'],
      openings: ['This table gets used more than anything else in the living room.', 'Remotes, drinks, books, laptop — it handles everything we put on it.'],
      middles: ['Surface size is generous enough to be useful without feeling like a buffet table.', 'Lower shelf adds extra storage that we actually use.'],
      closings: ['A practical living room staple.'],
      reservations: ['Wish the lower shelf was a bit higher for clearance.'],
    },
    comfort_usability: {
      titles: ['Right height from the sofa', 'Easy to use daily', 'Well-made surface'],
      openings: ['Height is just right — comfortable to reach from a seated position without leaning.', 'Surface is solid and level with no flex or wobble.'],
      middles: ['Material wipes clean easily, which matters for everyday use.'],
      closings: ['Works exactly as a coffee table should.'],
      reservations: ['Edges are slightly sharp — worth noting if small children use the room.'],
    },
    value: {
      titles: ['Looks more expensive in person', 'Great value for a living room essential', 'Quality surface for the price'],
      openings: ['Looked at several coffee tables at twice the price before landing on this one.', 'Quality looks higher end than the price suggests.'],
      middles: ['Solid construction and the finish is clean from every angle.'],
      closings: ['Would recommend.'],
      reservations: ['Minor assembly required but nothing complicated.'],
    },
    social_use: {
      titles: ['Perfect for entertaining', 'Great for movie nights', 'Living room finally feels complete'],
      openings: ['The living room feels finished now — had been without a coffee table for too long.', 'Works perfectly for movie nights and casual entertaining.'],
      middles: ['Good size for hosting — fits glasses, snacks, and a couple of remotes with room to spare.'],
      closings: ['A living room essential we should have bought sooner.'],
      reservations: ['Could use a small tray to organize the surface better.'],
    },
  },

  console_table: {
    room_fit: {
      titles: ['Entryway finally has a landing spot', 'Depth is perfect for a hallway', 'Looks intentional by the door'],
      openings: ['The entryway finally looks finished — this table was exactly what it needed.', 'Narrow enough to not block foot traffic but still functional.'],
      middles: ['The proportions are right for a hallway — slim and upright.', 'Looks intentional and elevated rather than like an afterthought.'],
      closings: ['Great first impression piece.'],
      reservations: ['Wall anchoring recommended for safety in high-traffic areas.'],
    },
    practical_use: {
      titles: ['Keys and mail finally have a home', 'Practical entryway solution', 'Gets used every day'],
      openings: ['Keys, mail, sunglasses — everything has a landing spot now.', 'Solved the entryway clutter problem immediately.'],
      middles: ['Lower shelf handles bags and shoes.', 'Surface is the right size to hold daily essentials without getting cluttered.'],
      closings: ['An entryway essential we should have bought sooner.'],
      reservations: ['Surface could be a bit wider but functional for the purpose.'],
    },
    comfort_usability: {
      titles: ['Slim and practical', 'Works well in a narrow space', 'Well-thought-out proportions'],
      openings: ['The narrow depth is the key feature here — fits without making the hallway feel tight.', 'Stable even with everyday items stacked on it.'],
      middles: ['Legs are sturdy and it doesn\'t wobble when you put things on or take things off.'],
      closings: ['A well-proportioned piece for a narrow space.'],
      reservations: ['Slim legs mean you notice fingerprints more easily but wipes clean.'],
    },
    value: {
      titles: ['Good value for an entryway piece', 'Looks clean for the price', 'Quality console for the money'],
      openings: ['Looks much better in person and at this price point it\'s an easy recommendation.'],
      middles: ['Good build quality — no flex in the legs under normal use.'],
      closings: ['Very happy with the purchase.'],
      reservations: ['Wood grain visible up close — not a flaw, just natural material variation.'],
    },
    social_use: {
      titles: ['First thing guests see', 'Sets the tone for the home', 'Good impression piece'],
      openings: ['Guests notice the entryway first and this table makes it look like we have our life together.', 'First thing visitors see and it sets a good tone.'],
      middles: ['It\'s a small piece but it changes how the entry feels entirely.'],
      closings: ['A worthwhile investment in a first impression.'],
      reservations: ['Surface decor matters more for a console than any other piece — pick accessories carefully.'],
    },
  },

  dining_table: {
    room_fit: {
      titles: ['Fits the dining area well', 'Right scale for the space', 'Dining room finally complete'],
      openings: ['The dining area feels properly furnished now — this table fills the space correctly.', 'Scale is right for our dining room without making it feel cramped.'],
      middles: ['Surface is at the right height for dining chairs and looks level and clean.', 'The finish pairs well with a variety of chair styles.'],
      closings: ['A proper dining room table that does everything it should.'],
      reservations: ['Finish showed minor scuffs after heavy use — worth using placemats.'],
    },
    practical_use: {
      titles: ['Family seats around it daily', 'Surface holds up to meals', 'Practical dining table'],
      openings: ['We eat at this table every day and it holds up well to daily use.', 'The whole family fits comfortably — right size for four.'],
      middles: ['Surface wipes clean and the frame has stayed stable without any loosening.'],
      closings: ['A reliable family dining table.'],
      reservations: ['Some wood grain variation visible which is natural but worth noting.'],
    },
    comfort_usability: {
      titles: ['Right height for dining', 'Stable and solid surface', 'Good everyday table'],
      openings: ['Height is right for standard dining chairs — no awkward reaching or hunching.', 'Solid and level surface that doesn\'t flex under a full meal setting.'],
      middles: ['Substantial enough to feel like a real dining table.'],
      closings: ['Works exactly as it should.'],
      reservations: ['Heavy piece — having help on delivery is a good idea.'],
    },
    value: {
      titles: ['Looks more expensive', 'Solid value for a dining table', 'Great family dining purchase'],
      openings: ['For a dining table, the price-to-quality ratio here is genuinely good.'],
      middles: ['The finish and construction look significantly more expensive than they are.'],
      closings: ['Would recommend.'],
      reservations: ['Occasional knot in the wood is visible — natural character but worth knowing.'],
    },
    social_use: {
      titles: ['Great for hosting dinners', 'Seated 8 comfortably', 'Works for entertaining'],
      openings: ['Hosted our first dinner party on this and it held up perfectly.', 'Fits six comfortably and eight if needed with a leaf.'],
      middles: ['The table held all the dishes and drinks without feeling crowded.'],
      closings: ['A great entertaining centerpiece for the dining room.'],
      reservations: ['Gets a lot of marks and rings with entertaining use — protective coasters are essential.'],
    },
  },

  bookshelf: {
    room_fit: {
      titles: ['Turned a blank wall into the most interesting part of the room', 'Makes the vertical space actually useful', 'The room needed something tall — this works'],
      openings: ['This bookshelf made a wall that felt empty look designed and purposeful.', 'The vertical space in our living room was completely unused before this.'],
      middles: ['Scale and proportion feel right — tall without being top-heavy.', 'The finish works with our existing furniture.'],
      closings: ['A great way to use vertical wall space.'],
      reservations: ['Anchoring to the wall is essential — not optional for taller units.'],
    },
    practical_use: {
      titles: ['Books and decor both fit', 'Practical display and storage', 'Shelves work well'],
      openings: ['Holds all our books plus a few plants and decorative pieces — exactly what we needed.', 'We used this for books, board games, and decorative objects and it handles all of it.'],
      middles: ['Shelf spacing is practical for most standard paperbacks and hardcovers.', 'Adjustable shelves give flexibility for different sized items.'],
      closings: ['A versatile everyday storage and display piece.'],
      reservations: ['Middle shelves bow slightly under heavy book loads — spread weight evenly.'],
    },
    comfort_usability: {
      titles: ['Everything visible and reachable without digging', 'Shelf spacing works for real book and decor mixing', 'Layout makes more sense once you start filling it'],
      openings: ['Everything is visible and accessible — no digging through boxes anymore.', 'Shelf spacing is well-thought-out for real-life use.'],
      middles: ['Bottom shelf is low but useful for larger items like binders and oversized books.'],
      closings: ['A practical, well-used piece.'],
      reservations: ['Top shelf requires a step stool for shorter users.'],
    },
    value: {
      titles: ['Great value for vertical storage', 'Looks clean for the price', 'Good investment in a room'],
      openings: ['For the storage capacity and the look, the value is genuinely strong.'],
      middles: ['Construction is solid enough that it doesn\'t flex or wobble when fully loaded.'],
      closings: ['A good value piece that adds a lot to the room.'],
      reservations: ['Back panel is thinner than the frame but holds fine once assembled.'],
    },
    social_use: {
      titles: ['The room finally has a focal point', 'Adds more character than any other single piece', 'A filled bookshelf changes how a room feels'],
      openings: ['This has become the focal point of the room — everyone looks at it.', 'Guests always drift toward it and browse our book and decor collection.'],
      middles: ['A filled bookshelf adds more personality to a room than almost anything else.'],
      closings: ['A great investment in both function and the character of a room.'],
      reservations: ['Styling it well takes some effort but that\'s true of any open shelving.'],
    },
  },

  tv_stand: {
    room_fit: {
      titles: ['Living room looks much cleaner', 'Right scale for our screen', 'Media area finally organized'],
      openings: ['The living room looks significantly more intentional with this media stand in place.', 'Scale is right for our TV — the proportions are well-matched.'],
      middles: ['Low-profile design keeps the screen as the focus without the furniture competing.', 'The finish pairs well with both dark and light room palettes.'],
      closings: ['A real living room upgrade.'],
      reservations: ['Cable management could be better but manageable with some creativity.'],
    },
    practical_use: {
      titles: ['Everything has a place now', 'Devices all stored properly', 'Cable clutter is gone'],
      openings: ['All our media devices, remotes, and cables are now properly organized.', 'Went from a mess of cables and boxes on the floor to everything hidden away.'],
      middles: ['Closed storage handles the devices and the open section works for the main console.', 'The cabinet proportions work for our sound bar and streaming devices.'],
      closings: ['A practical media storage solution.'],
      reservations: ['Could use more cable routing holes but manageable.'],
    },
    comfort_usability: {
      titles: ['TV height works well', 'Easy access to devices', 'Well-designed media piece'],
      openings: ['TV height is right for watching from the sofa — no neck strain.', 'Doors open fully to access devices without fuss.'],
      middles: ['Surface is solid enough for a large flat screen without any flex.'],
      closings: ['Well-designed for its purpose.'],
      reservations: ['Doors on the side sections are slightly awkward to open from a seated position.'],
    },
    value: {
      titles: ['Great media storage value', 'Looks clean for the price', 'Good living room upgrade'],
      openings: ['The living room feels upgraded and nothing else changed — just this stand.'],
      middles: ['Looks more substantial and premium than the price suggests.'],
      closings: ['Recommended for anyone looking to clean up their media setup.'],
      reservations: ['Shelves could be more adjustable but works for standard media equipment.'],
    },
    social_use: {
      titles: ['Living room looks finished', 'Great for a social space', 'Room feels intentional now'],
      openings: ['The living room finally looks like a proper space for watching and entertaining.', 'Having a real media stand rather than a table or makeshift setup makes a huge difference.'],
      middles: ['Everything is tidied up and accessible without the room looking like an electronics store.'],
      closings: ['A worthwhile living room investment.'],
      reservations: ['May want a separate speaker stand if audio setup is elaborate.'],
    },
  },

  desk: {
    room_fit: {
      titles: ['Fits the corner perfectly', 'Home office looks professional', 'Right scale for the room'],
      openings: ['This desk fits our awkward home office corner perfectly.', 'The home office finally looks like a real workspace.'],
      middles: ['The footprint is right — big enough to be functional but not dominating the room.', 'Finish coordinates well with other furniture and doesn\'t scream "office furniture."'],
      closings: ['A home office upgrade that was worth it.'],
      reservations: ['Color varied slightly from photos but works well in the space.'],
    },
    practical_use: {
      titles: ['Workspace is well-sized', 'Keeps work separate', 'Great for working from home'],
      openings: ['Surface is large enough for a laptop, notepad, and a couple of extras without feeling cramped.', 'Having a dedicated workspace has actually improved how much I get done.'],
      middles: ['Drawer keeps daily office supplies accessible without cluttering the surface.', 'Cable management is actually useful — worth noting.'],
      closings: ['A well-designed home office solution.'],
      reservations: ['Drawer is shallow — fine for pens and small items but not much more.'],
    },
    comfort_usability: {
      titles: ['Surface height is right', 'Good for long work sessions', 'Well-designed workspace'],
      openings: ['Height works with most standard chairs without adjustment.', 'Surface is solid with no flex — important for mouse and keyboard use.'],
      middles: ['The layout makes sense for how people actually work.'],
      closings: ['A practical desk that does its job well.'],
      reservations: ['Could use an integrated power strip or USB port but easy to add separately.'],
    },
    value: {
      titles: ['Looks professional for the price', 'Good value home office piece', 'Quality work surface'],
      openings: ['For a home office desk, this offers good quality at a fair price.'],
      middles: ['Looks more solid and polished than other desks I compared at this price point.'],
      closings: ['Happy with the purchase.'],
      reservations: ['Assembly required a bit of patience but instructions were clear enough.'],
    },
    social_use: {
      titles: ['Looks great on video calls', 'Professional home office setup', 'Guests notice the setup'],
      openings: ['Colleagues on video calls have asked about the home office setup — the desk is a big part of that.', 'Finally have a workspace that looks intentional rather than improvised.'],
      middles: ['Having a proper desk changed how I think about working from home.'],
      closings: ['A solid investment for anyone who works from home regularly.'],
      reservations: ['Could be slightly deeper for dual-monitor setups.'],
    },
  },

  pet_furniture: {
    room_fit: {
      titles: ["Doesn't look like a litter box", 'Blends with the room', 'Finally pet furniture that fits the space'],
      openings: ['Guests have walked right past this without realizing what it is.', 'This is the first pet piece we\'ve had that actually looks like furniture.'],
      middles: ['The finish matches our other pieces well enough that it just reads as a small side table.', 'Clean lines and a simple form that doesn\'t read as "pet product" from across the room.'],
      closings: ['A pet solution that works for the room, not against it.'],
      reservations: ['Took a few days for our cat to warm up to it but now uses it consistently.'],
    },
    practical_use: {
      titles: ['Cat uses it consistently', 'Easier to clean than before', 'Practical everyday pet solution'],
      openings: ['The cat took to this much faster than our previous enclosure.', 'Cleaning is genuinely easier — access is well-designed.'],
      middles: ['The drawer for litter storage makes the whole routine less annoying.', 'Ventilation is adequate and the interior is a practical size.'],
      closings: ['A well-thought-out functional pet piece.'],
      reservations: ['Ventilation could be slightly better in warm weather but nothing serious.'],
    },
    comfort_usability: {
      titles: ['Pet seems comfortable in it', 'Well-designed entry', 'Pet uses it voluntarily'],
      openings: ['Our cat went in voluntarily after two days — usually takes weeks with new furniture.', 'The entry size is right — not too tight, not so open it defeats the purpose.'],
      middles: ['Interior is the right size for our medium-sized cat.'],
      closings: ['A pet-friendly design that the pet actually confirmed.'],
      reservations: ['Might be tight for larger cats — check dimensions carefully before ordering.'],
    },
    value: {
      titles: ['Good value pet solution', 'Looks like furniture, priced like furniture', 'Worth it for a pet owner'],
      openings: ['We spent a long time looking for something that looked like furniture and came in at a reasonable price — this does both.'],
      middles: ['The dual-purpose design as a side table and pet enclosure justifies the price.'],
      closings: ['A worthwhile purchase for any pet owner who cares about how the room looks.'],
      reservations: ['Slightly more expensive than a standard litter box but the aesthetic difference is obvious.'],
    },
    social_use: {
      titles: ['Guests never notice it first', 'Room stays polished', 'Solved the "visible litter box" problem'],
      openings: ["We've had guests over who sat next to this and didn't realize it was for the cat.", 'The room stays looking clean even with the pet setup in it.'],
      middles: ['Visual clutter from pet furniture was one of our main living room complaints — solved.'],
      closings: ['Highly recommend for anyone who wants a social space that also accommodates pets.'],
      reservations: ['Requires consistent cleaning to maintain the clean appearance.'],
    },
  },

  fallback: {
    room_fit: {
      titles: ['Looks better in the room than in the product photos', 'Fits without any awkward adjustments', 'Better proportions than we expected'],
      openings: ['This piece works well in our home and looks better in person than in photos.', 'Good proportions and the finish is cleaner than we expected.'],
      middles: ['Scale is appropriate and it doesn\'t overcrowd the space.'],
      closings: ['Happy with how it fits the room.'],
      reservations: ['Looks better in person than expected — color was slightly different from photos but still works well.'],
    },
    practical_use: {
      titles: ['Held up to daily use without any issues', 'Works exactly as we needed it to', 'Nothing flashy — just reliable'],
      openings: ["We've been using this for a few months and it holds up well to daily use.", "Does exactly what we needed it to do."],
      middles: ['Build quality is solid and nothing has loosened or worn with regular use.'],
      closings: ['A reliable everyday piece.'],
      reservations: ['Works well and holds up to regular use — minor assembly required but straightforward.'],
    },
    comfort_usability: {
      titles: ['Works smoothly after months of daily use', 'Build feels more solid than the price suggested', 'No complaints after extended regular use'],
      openings: ['Everything works as it should — no complaints after months of use.'],
      middles: ['Build quality is better than expected and the finish is clean.'],
      closings: ['A solid, well-made piece.'],
      reservations: ['Solid piece overall — assembly took some patience, but the end result is sturdy.'],
    },
    value: {
      titles: ['More solid than expected for the price', 'Reads as more premium than the cost', 'Better value than alternatives we considered'],
      openings: ['Better quality than the price suggested — pleasantly surprised.'],
      middles: ['Finish and construction look more premium than the cost.'],
      closings: ['Would recommend.'],
      reservations: ['Really happy with the value — a few minor details on close inspection, but nothing that affects function or the overall look.'],
    },
    social_use: {
      titles: ['Adds to the room without calling attention to itself', 'Works well for both everyday use and when people visit', 'A quiet upgrade that people actually notice'],
      openings: ["We've had compliments on this piece from people who noticed it."],
      middles: ['Adds to the overall feel of the room rather than just filling space.'],
      closings: ['A good home furniture investment.'],
      reservations: ['Works well for a social home — took some deliberation on placement, but worth finding the right spot.'],
    },
  },
};

// ── Theme logic ───────────────────────────────────────────────────────────────

const THEME_ORDER: ReviewTheme[] = ['room_fit', 'practical_use', 'comfort_usability', 'value', 'social_use'];

function getBank(cat: ReviewCategory): CategoryBank {
  return BANKS[cat] ?? BANKS.fallback;
}

// ── Review assembly ───────────────────────────────────────────────────────────

export function buildReviewTitle(theme: ReviewTheme, product: ReviewableProduct, seed: number, offset: number): string {
  const cat = inferReviewCategory(product);
  const bank = getBank(cat);
  return pick(bank[theme].titles, seed, offset);
}

export function buildReviewBody(
  theme: ReviewTheme,
  product: ReviewableProduct,
  rating: number,
  signals: ReviewSignals,
  seed: number,
  offset: number,
): string {
  const cat = inferReviewCategory(product);
  const bank = getBank(cat);
  const block = bank[theme];

  const opening = pick(block.openings, seed, offset);
  const middle  = pick(block.middles, seed, offset + 1);
  let body = `${opening} ${middle}`;

  if (rating === 4) {
    const reservation = pick(block.reservations, seed, offset);
    body += ` ${reservation}`;
  } else {
    const closing = pick(block.closings, seed, offset);
    body += ` ${closing}`;
  }

  return body.trim();
}

export function generateSingleReview(
  product: ReviewableProduct,
  theme: ReviewTheme,
  rating: number,
  priorityOffset: number,
  nameOffset: number,
): GeneratedReview {
  const cat = inferReviewCategory(product);
  const signals = extractReviewSignals(product, cat);
  const seed = hash(product.supplier_product_id + theme);

  return {
    supplier_product_id: product.supplier_product_id,
    rating,
    title: buildReviewTitle(theme, product, seed, priorityOffset),
    body: buildReviewBody(theme, product, rating, signals, seed, priorityOffset),
    reviewer_name: buildReviewerName(seed, nameOffset),
    helpful_count: (seed + priorityOffset * 3) % 7,
    review_source: 'generated',
    is_generated: true,
    verified_purchase: false,
    status: 'active',
    display_priority: 500 + priorityOffset,
    tags: generateReviewTags(product),
  };
}

export function generateReviewSet(product: ReviewableProduct): GeneratedReview[] {
  // 5-review set: 5,5,5,4,4
  const configs: { theme: ReviewTheme; rating: number }[] = [
    { theme: 'room_fit',          rating: 5 },
    { theme: 'practical_use',     rating: 5 },
    { theme: 'comfort_usability', rating: 5 },
    { theme: 'value',             rating: 4 },
    { theme: 'social_use',        rating: 4 },
  ];

  const reviews = configs.map((c, i) =>
    generateSingleReview(product, c.theme, c.rating, i, i + 1),
  );

  // Each review's name is hash(id+theme)+offset — independent seeds can collide mod 20.
  // The unique(supplier_product_id, reviewer_name) DB constraint requires no duplicates
  // within the set. Resolve any collision deterministically: probe the pool for the
  // next unused slot, seeded so the same product always resolves the same way.
  const seen = new Set<string>();
  const dedupBase = hash(product.supplier_product_id + 'dedup');
  return reviews.map((r, i) => {
    if (!seen.has(r.reviewer_name)) {
      seen.add(r.reviewer_name);
      return r;
    }
    let probe = 0;
    let name = r.reviewer_name;
    while (seen.has(name)) {
      name = REVIEWER_NAMES[(dedupBase + i * 7 + probe) % REVIEWER_NAMES.length];
      probe++;
    }
    seen.add(name);
    return { ...r, reviewer_name: name };
  });
}

// ── Tag generation ────────────────────────────────────────────────────────────

const CATEGORY_TAGS: Partial<Record<ReviewCategory, string[]>> = {
  sofa:             ['Looks better in person', 'Comfortable for evenings', 'Fits the room well', 'Holds shape nicely', 'Great for lounging'],
  sofa_bed:         ['Guests love it', 'Converts easily', 'Saves real space', 'Comfortable both ways', 'Great guest solution'],
  loveseat:         ['Right size for two', 'Fits small spaces', 'Cozy and comfortable', 'Holds shape well'],
  ottoman:          ['Works as extra seating', 'Great as footrest', 'Doubles as a table', 'Surprisingly versatile'],
  dining_chair:     ['Comfortable for long meals', 'Sturdy everyday use', 'Looks great at table', 'Easy to clean'],
  accent_chair:     ['Room focal point', 'Actually comfortable', 'Adds personality', 'Gets compliments'],
  office_chair:     ['Good lumbar support', 'Comfortable all day', 'Looks professional', 'Smooth height adjustment'],
  stool:            ['Tucks away cleanly', 'Stable under weight', 'Right counter height', 'Looks clean in kitchen'],
  cabinet:          ['Hides clutter well', 'Looks tidy in room', 'Top surface useful', 'Keeps things out of sight'],
  sideboard:        ['Great dining storage', 'Useful top surface', 'Keeps room organized', 'Fits the space well'],
  pantry:           ['Finally organized', 'Holds more than expected', 'Cleaner than open shelves', 'Great kitchen storage'],
  dresser:          ['Drawers slide smoothly', 'Keeps room organized', 'Holds everything easily', 'Blends in nicely'],
  nightstand:       ['Everything within reach', 'Drawer stays tidy', 'Right height for bed', 'Feels complete'],
  bathroom_vanity:  ['Getting ready is easier', 'Drawer layout is smart', 'Fits small bathrooms', 'Looks more expensive'],
  coffee_table:     ['Anchors the room', 'Easy to clean surface', 'Right sofa height', 'Used every day'],
  console_table:    ['Slim for hallways', 'Great landing spot', 'Looks intentional', 'Entryway feels finished'],
  dining_table:     ['Seats everyone comfortably', 'Surface holds up well', 'Great for hosting', 'Feels solid'],
  bookshelf:        ['Uses vertical space', 'Holds books and decor', 'Sturdy under weight', 'Became a feature wall'],
  tv_stand:         ['Media area looks clean', 'Devices fit easily', 'Right TV height', 'Cables stay hidden'],
  desk:             ['Good work surface', 'Helps me focus', 'Looks clean on calls', 'No wobble at all'],
  pet_furniture:    ['Blends with furniture', 'Pet uses it daily', 'Doesn\'t look pet-y', 'Less visual clutter'],
  fallback:         ['Looks better in person', 'Fits the space well', 'Holds up to use', 'Worth the price'],
};

export function generateReviewTags(product: ReviewableProduct): string[] {
  const cat = inferReviewCategory(product);
  const base = CATEGORY_TAGS[cat] ?? CATEGORY_TAGS.fallback!;
  const seed = hash(product.supplier_product_id + 'tags');
  // Shuffle deterministically and pick 4–5
  const count = 4 + (seed % 2);
  const shuffled = [...base].sort((a, b) => hash(a + product.supplier_product_id) - hash(b + product.supplier_product_id));
  return shuffled.slice(0, count);
}
