/**
 * Regression fixtures — real supplier titles captured from the saved-items plan artifact
 * (run 6b3415e4, 2026-07-27). Inlined rather than read from reports/, because those reports are
 * gitignored; a regression guard must not depend on a file that may be absent.
 *
 * OUTDOOR_POLICY_SKUS is the Founder assortment-decision set. Drift here changes what the Founder
 * is being asked to decide, so it is asserted SKU by SKU.
 */

/** The confirmed outdoor set awaiting one Founder assortment decision. */
export const OUTDOOR_POLICY_SKUS: ReadonlyArray<readonly [string, string]> = [
  ['69489.00DT', 'Expandable Daybed with Cushions,Outdoor Couch Acacia Wood Patio Couch with Adjustable Armrests,Outdoor Convertible Sofa with Removable Cushions&Pillows for Patio, Porch, Poolside'],
  ['74327.00BEIGE', 'Outdoor Extendable Acacia Wood 3 Seater Sofa, Upholstered Cushion Couch, Daybed Sofa Chair, Spacious Seating Lounge Chair, Patio Daybed Sofa for Garden Yard'],
  ['74327.00DT', 'Outdoor Extendable Acacia Wood 3 Seater Sofa, Upholstered Cushion Couch, Daybed Sofa Chair, Spacious Seating Lounge Chair, Patio Daybed Sofa for Garden Yard'],
  ['FG201231AAA', 'GO 3 Pieces Acacia Wood Table Bench Dining Set For Outdoor & Indoor Furniture With 2 Benches, Picnic Beer Table for Patio, Porch, Garden, Poolside, Natural'],
  ['FG201233AAA', 'GO 7 Pieces Outdoor Patio Furniture, All-Weather Rattan Sectional Sofa Set with Thick Cushions and Pillows, Freely Combined Conversation Sets for Garden, Backyard, Balcony, Beige'],
  ['N704F201246A', '<Old SKU: N704G201246A> GO 4-Piece Outdoor Furniture Sofa Set for 5 People with Acacia Wood Armrests, Patio Conversation Set with Removable Cushion and Solid Wood Coffee Table for Garden,Beige'],
  ['N704F201246E', '<Old SKU: N704G201246E> GO 4-Piece Outdoor Furniture Sofa Set for 5 People with  Acacia Wood Armrests, Patio Conversation Set with Removable Cushion and Solid Wood Coffee Table  for Garden, Grey'],
  ['N704F201249E', '<Old SKU: N704G201249E> 4 Pieces Outdoor Acacia Wood Sofa Set, Woven Mesh Armrests, L-Shaped Patio Furniture Sofa Set with Coffee Table, Outdoor Conversation Set with Gray Cushions and Side Table'],
  ['N704F201249N', 'GO 4 Pieces Outdoor Acacia Wood Sofa Set, Woven Mesh Armrests, L-Shaped Patio Furniture Sofa Set with Coffee Table, Outdoor Conversation Set with Beige Cushions and Side Table, Teak Color Look'],
  ['N704G201207A', '<Old SKU: FV201207AAK. Note: Modify Size>Wood Structure Outdoor Sofa Set with beige Cushions Exotic design Water-resistant and UV Protected texture High quality acacia wood Strong Metal Accessories'],
  ['N704G201207E', '<Old SKU: FV201207AAE. Note: Modify Size> Wood Structure Outdoor Sofa Set with gray Cushions Exotic design Water-resistant and UV Protected texture High quality acacia wood Strong Metal Accessorie'],
  ['N704G201233D', 'GO 7 Pieces Outdoor Patio Furniture, All-Weather Rattan Sectional Sofa Set with Thick Cushions and Pillows, Freely Combined Conversation Sets for Garden, Backyard, Balcony, Brown'],
  ['N704G201257A', 'Aluminum Frame Large 4-Piece Outdoor Patio Furniture Set for 5 Person, 3-Seater Sofa, 2 Armchairs with Fold-Out Side Tables, Modern Garden/Patio Seating, All-Weather Use, Beige Cushions'],
  ['N704G201257E', 'Aluminum Frame Large 4-Piece Outdoor Patio Furniture Set for 5 Person, 3-Seater Sofa, 2 Armchairs with Fold-Out Side Tables, Modern Garden/Patio Seating, Grey Cushions'],
  ['N707S000011G', 'K&K 7-Piece Wicker Patio Furniture Set, Outdoor Conversation Set Sectional Sofa with Water Resistant Grey Thick Cushions and Coffee Table for Outdoor Couch, Porch, Backyard - Grey'],
  ['N707S000011Z', 'K&K 7-Piece Wicker Patio Furniture Set, Outdoor Conversation Set Sectional Sofa with Water Resistant Beige Thick Cushions and Coffee Table for Outdoor Couch, Porch, Backyard - Beige'],
  ['N717P453341A', 'TOPMAX Outdoor Acacia Wood Round Daybed, Patio Lounger with Curved Slatted Backrest, Cushion and 4 Pillows for Backyard, Poolside, Beige'],
  ['N717S100006D', 'TOMAX 5-Piece Outdoor Patio Rattan Sofa Set, Sectional PE Wicker L-Shaped Garden Furniture Set with 2 Extendable Side Tables, Dining Table and Washable Covers for Backyard, Poolside, Indoor, Brown'],
  ['N717S100006K', 'TOMAX 5-Piece Outdoor Patio Rattan Sofa Set, Sectional PE Wicker L-Shaped Garden Furniture Set with 2 Extendable Side Tables, Dining Table and Washable Covers for Backyard, Poolside, Indoor, White'],
  ['N717S100149A', 'TOPMAX 5 Pieces All-Weather Brown PE Rattan Wicker Sofa Set Outdoor Patio Sectional Furniture Set Half-Moon Sofa Set with Tempered Glass Table, Beige'],
  ['N717S100149E', 'TOPMAX 5 Pieces All-Weather Brown PE Rattan Wicker Sofa Set Outdoor Patio Sectional Furniture Set Half-Moon Sofa Set with Tempered Glass Table, Grey'],
  ['N717S110006E', 'TOMAX 5-Piece Outdoor Patio Rattan Sofa Set, Sectional PE Wicker L-Shaped Garden Furniture Set with 2 Extendable Side Tables, Dining Table and Washable Covers for Backyard, Poolside, Indoor, Grey'],
  ['N757P395516I', 'Outdoor Patio Sofa 3 Seater'],
  ['N757P408831B', 'Outdoor Acacia Wood and Rope 3 Seater Patio Sofa'],
  ['N757S342866B', 'Outdoor 3-piece Acacia Wood and Rope Patio Sofa Set'],
  ['N757S354829B', 'Outdoor 3pcs Acacia Sectional Patio Sofa Set (old sku N757S338060B)'],
  ['N757S454841B', 'Outdoor 4pc Acacia Wood Sectional Patio Sofa Set (old sku N757S441724D)'],
  ['N757S542305B', 'Outdoor 5-piece Acacia Wood and Rope Patio Sofa Set'],
  ['N757S554832B', 'Outdoor 5pcs Acacia Sectional Patio Sofa Set  (old sku N757S538061B-1)'],
  ['N770P469100B_N770P285267B', 'Black Iron + Teak Finish Outdoor Chaise Lounge Set with Beige Cushion, 400 lbs Capacity, 4" Thick 4-Fold Water-Resistant Cushion with Headrest, Adjustable Backrest with Flat Storage Surface for Patio'],
  ['SP100023AAA', 'TOPMAX Patio Furniture Round Outdoor Sectional Sofa Set Rattan Daybed Two-Tone Weave Sunbed with Retractable Canopy, Separate Seating and Removable Cushion, Beige'],
  ['SP100031AAA', 'TOPMAX 6 Piece Patio Sofa Set, Acacia Wood Outdoor Modular Sectional Garden Furniture Set L-Shaped Conversation Set, Convertible Daybed with Tea Table, Ottoman, 5 Cushions and Pillows, Teak+Beige'],
  ['SP100039AAA', 'TOPMAX 8-Piece Acacia Wood Outdoor Patio Sofa Set, Modular Sectional Furniture Set with Storage Tea Table, Coffee Table and Cushions for Backyard, Poolside, Indoor&Outdoor, Beige'],
  ['SP100141AAN', 'TOPMAX Outdoor Adjustable Patio Wooden Daybed Sofa Chaise Lounge with Cushions for Small Places, Natural Finish+Beige Cushion'],
  ['SP110142AAA', 'TOPMAX Outdoor Backyard Patio Wood 5-Piece Sectional Sofa Seating Group Set with Cushions, Natural Finish+ Beige Cushions'],
  ['SP110142AAC', 'TOPMAX Outdoor Backyard Patio Wood 5-Piece Sectional Sofa Seating Group Set with Cushions, Natural Finish+ Blue Cushions'],
  ['T6125S00005', '7-Piece Outdoor Patio Furniture Set, All-Weather Wicker Rattan Sectional Sofa with Thick Cushions & Glass Table, Modular Patio Conversation Furniture for Backyard, Poolside & Garden (Grey-Blue)'],
  ['T6125S00006', 'KROFEM 4-Piece Patio Furniture Set, Wicker Outdoor Rattan Sectional Sofa with Cushions and Glass Table, All-Weather Outdoor Conversation Set for Garden, Porch, Backyard, Patio (Brown-Blue)'],
  ['W2500P479541', 'Folding PE Rattan Hanging Egg Chair with Stand, Gray Indoor Outdoor Hammock Swing Basket Chair, Aluminum Steel Frame for Patio Balcony Backyard Bedroom'],
  ['W874S00045', 'Outdoor Patio Furniture 7-Piece Half-Moon Sectional Round Patio Furniture Set Sofa with Tempered Glass Round Coffee Table'],
  ['WY000478AAE', 'U_Style U-Shaped Outdoor Sectional Sofa Set with 5.9\'\' Ultra-Thick Cushions, All Weather 5-6 Seat Patio Conversation Sofa with Heavy-Duty Iron Frame,Suitable for Backyard, Garden,Poolside'],
  ['WY000480AAE', 'U_style Outdoor L-Shaped Sofa with Iron Frame,Weather-Resistant Patio Sofa Set with Ultra-Thick Cushions,Comfortable Seating for 3,Ideal for Patio, Balcony,and Garden'],
];

/** Indoor furniture wrongly excluded by the legacy gate — these must stay rescued. */
export const RESCUED_FURNITURE_SKUS: ReadonlyArray<readonly [string, string]> = [
  ['LT000328AAK', 'Wooden Twin Over Full Bunk Bed, Loft Bed with Playhouse, Farmhouse, Ladder, Slide and Guardrails, White(OLD SKU :LT000028AAK)'],
  ['N7090004021K', 'Twin Size Murphy Bed with 3 Drawers, White'],
  ['W1935P300342', 'White Twin Metal Triple Bunk Bed with Removable Design – Durable Iron Structure, Separates Into Three Twin Beds, Space-Saving Configuration, Elegant White Finish'],
  ['W1935P300361', 'Silver Twin Metal Triple Bunk Bed Frame – Versatile Convertible 3-in-1 Design, Heavy-Duty Steel, Sleek Silver Finish, Ideal for Dorms/Guest Rooms'],
  ['W2200P313805', 'Bean Bag Chair, Bean Bag Sofa Chair with Armrests Stuffed High-Density Foam, Lazy Sofa Comfy Chairs BeanBag Chair for Adults in Living Room,Bedroom Reading'],
  ['W2200P313807', 'Bean Bag Chair, Bean Bag Sofa Chair with Armrests Stuffed High-Density Foam, Lazy Sofa Comfy Chairs BeanBag Chair for Adults in Living Room,Bedroom Reading'],
  ['W2200P313809', 'Bean Bag Chair, Bean Bag Sofa Chair with Armrests Stuffed High-Density Foam, Lazy Sofa Comfy Chairs BeanBag Chair for Adults in Living Room,Bedroom Reading'],
  ['W2311P357139', 'Lotus type compression sofa Adult bean bag sofa with pull ring can be easily moved without installation Suitable for various environments such as living room, bedroom, etc. Relax and enjoy life,white'],
  ['W2311P357140', 'Lotus type compression sofa Adult bean bag sofa with pull ring can be easily moved without installation Suitable for various environments such as living room, bedroom, etc. Relax and enjoy life,Pink'],
];

/** Genuinely non-furniture — must never become furniture. */
export const NON_FURNITURE_SKUS: ReadonlyArray<readonly [string, string]> = [
  ['N726P461951N', 'Luggage Set of 3, 20-inch with USB Port, Airline Certified Carry-on Luggage  , ABS+PC Hard Shell Luggage with Spinner Wheels, Gradient Blue'],
  ['W1019P326438', 'Multiple Colors,Girls Bike with Basket for 7-10 Years Old Kids,20 inch  wheel ,No Training Wheels Included'],
  ['W1019P326439', 'Multiple Colors,Girls Bike with Basket for 7-10 Years Old Kids,20 inch  wheel ,No Training Wheels Included'],
  ['W1019P326440', 'Multiple Colors,Girls Bike with Basket for 7-10 Years Old Kids,20 inch  wheel ,No Training Wheels Included'],
  ['W1163P315233', '55-inch Trampoline for Kids Indoor & Outdoor Small Toddler Trampoline with Basketball Hoop'],
  ['W1612P461382', 'STAINLESS STEEL CAT LITTER BOX'],
  ['W1612P461506', 'STAINLESS STEEL CAT LITTER BOX'],
  ['W215P296966', '2025 New Quiet Smart Pet Treadmill, Adjustable Speed, Perfect for Small/Medium Dogs'],
  ['W215P423356', 'Small Dog Treadmill 2026 Edition - High-Value, Low-Noise Pet Exercise Machine for Indoor Puppy Training, Portable Running Wheel'],
  ['W2531P353603', 'Stair Stepper with Resistance Home-Upgrade Vertical Climber Workout Machine for Full-Body Exercise Climber Fitness Equipment with Stable Frame Adjustable Handlebar-Pink'],
  ['W2787P262955', '20"/24"/28" 3 pcs/set in ABS Spinner Wheel Luggage, Carry on Suitcase, with Cup Holder & USB Port & Phone Holder (Pink)'],
  ['W2787P262959', '20"/24"/28" 3 pcs/set in ABS Spinner Wheel Luggage, Carry on Suitcase, with Cup Holder & USB Port & Phone Holder (Mint Green)'],
  ['W2787P292629', '20"/24"/28" 3 pcs/set in ABS Spinner Wheel Luggage, Carry on Suitcase, Matching Color, TSA Combination Lock (Black+Orange)'],
  ['W2787P365245', '20"/24"/28" 3 pcs/set in ABS Spinner Wheel Luggage, Matching Color , With Combination Lock (Silver)'],
  ['W2787P378176', '14"/20" 2 pcs/set in ABS Spinner Wheel Luggage, with Combination Lock and Front Opening Design, 14" Cosmetic Case (Brown)'],
  ['W2787P408593', '14"/20"/24"/28"  4 pcs/set in PP Spinner Wheel Luggage, Carry on Suitcase, Iron Pull Rod, Combination Password Lock, 14" Cosmetic Case (Blue)'],
  ['W2787P437272', '28 Inch ABS Hard Shell Large Travel Checked Luggage - Scratch Resistant Surface Four Multi-Directional Wheels,  With Combination Lock and Side Hooks .(Silver)'],
  ['W2921P221486', 'FKZNPJ 16 inch sporty kids bike with training wheels and stand Adjustable saddle Suitable for boys and girls aged 4-8 years tall Height 41-53 inches Available in a variety of colors'],
  ['W2921P222921', 'FKZNPJ 16 inch sporty kids bike with training wheels and stand Adjustable saddle Suitable for boys and girls aged 4-8 years tall Height 41-53 inches Available in a variety of colors'],
  ['W2921P222922', 'FKZNPJ 18 inch sporty kids bike with training wheels and stand Adjustable saddle Suitable for boys and girls aged 5-10 years tall Height 45-57 inches Available in a variety of colors'],
  ['W2921P222923', 'FKZNPJ 18 inch sporty kids bike with training wheels and stand Adjustable saddle Suitable for boys and girls aged 5-10 years tall Height 45-57 inches Available in a variety of colors'],
  ['W2921P222926', 'FKZNPJ 18 inch sporty kids bike with training wheels and stand Adjustable saddle Suitable for boys and girls aged 5-10 years tall Height 45-57 inches Available in a variety of colors'],
  ['W2921P368548', 'FKZNPJ Kids Bike 16 Inch – High Carbon Steel Frame, Magnesium Alloy Wheels, Training Wheels with Night Glow, Adjustable Seat, Water Bottle – Girls & Boys Bicycle Ages 3-9, Toddler Bike'],
  ['W2921P368550', 'FKZNPJ Kids Bike 16 Inch – High Carbon Steel Frame, Magnesium Alloy Wheels, Training Wheels with Night Glow, Adjustable Seat, Water Bottle – Girls & Boys Bicycle Ages 3-9, Toddler Bike'],
  ['W2921P368557', 'FKZNPJ Kids Bike 16 Inch – High Carbon Steel Frame, Magnesium Alloy Wheels, Training Wheels with Night Glow, Adjustable Seat, Water Bottle – Girls & Boys Bicycle Ages 3-9, Toddler Bike'],
  ['W2921P368572', 'FKZNPJ Kids Bike 18 Inch – High Carbon Steel Frame, Magnesium Alloy Wheels, Training Wheels with Night Glow, Adjustable Seat, Water Bottle – Girls & Boys Bicycle Ages 3-9, Toddler Bike'],
  ['W2921P368576', 'FKZNPJ Kids Bike 18 Inch – High Carbon Steel Frame, Magnesium Alloy Wheels, Training Wheels with Night Glow, Adjustable Seat, Water Bottle – Girls & Boys Bicycle Ages 3-9, Toddler Bike'],
  ['W2921P426729', 'FKZNPJ 20 Inch Kids Mountain Bike, 7-Speed Youth Bicycle with Magnesium Alloy Frame & One-Piece Wheels, Lightweight Kids Bike for Boys and Girls Ages 8–12'],
  ['W3101P314628', '48.8" Modern Cat Tower, Wood Cat Tree Tower for Indoor Cats, Cat Treewith Sisal-Covered Scratching Posts and Top Perch, Cat Condo with Acrylic Hammock for Small Large Cats'],
  ['W3297P297490', 'Portable Basketball Hoop for Youth Adults & Professional Match,Adjustable Height 8.04 ft to 10.01 ft,39 inch Backboard with Rebound System, Indoor/Outdoor Basketball Goal with Rebound Board and Wheels'],
];
