# ClaudeCode Execution Rules — Xself Home App

IMPORTANT:
Read this file before any task.
Follow it strictly.

If conflict exists:
→ This file overrides task instructions.

---

# 1. Core Execution Rule

Make minimal, targeted changes.

Only modify what is explicitly required.

---

# 2. Hard Constraints (NON-NEGOTIABLE)

- Do NOT modify working features
- Do NOT refactor unrelated files
- Do NOT optimize unrelated systems
- Do NOT fix “related issues”
- Do NOT rewrite stable logic
- Do NOT introduce structural changes

---

# 3. Stop Conditions (MANDATORY)

STOP and explain BEFORE proceeding if:

- Change affects shared logic
- Change impacts multiple screens
- Change touches protected systems
- Requirements are unclear

If unsure:
→ ASK, do NOT guess

---

# 4. Protected Systems — DO NOT TOUCH

Unless explicitly required by the task.

### Review System
- ReviewSection.tsx
- reviewSubmitter.ts
- reviewModerator.ts
- reviewGenerator.ts
- seedGeneratedReviews.ts

### Recommendation System
- You May Also Like
- Frequently Bought Together
- ProductDetail recommendation logic

### Category System
- category_label
- category_priority
- is_new_arrival
- new_arrival_source

### Search System
- SKU search
- keyword search
- image search
- sku_search normalization

---

# 5. Scope Rules

- Only change files directly related to the task
- Do NOT touch protected systems
- Do NOT rewrite existing logic unless required
- Prefer small patches over rewrites

---

# 6. Forbidden Behavior

- Improving unrelated code
- Refactoring large sections
- Changing shared logic silently
- Rewriting stable modules
- Making assumptions about intent

---

# 7. Required Output

After completing any task, MUST report:

1. Files changed
2. Reason for change
3. What was NOT changed
4. Confirmation protected systems untouched