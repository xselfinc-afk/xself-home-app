# XSelf Product Supply Intelligence — Documentation Workspace

This folder contains the **highest-level design documents for the entire XSelf Product Supply
Intelligence System**. It is the canonical source of truth for the system's vision, business
model, architecture, and operating rules.

## Contents

- **PRODUCT_SUPPLY_INTELLIGENCE_BIBLE.md** — the Product Bible: the authoritative, top-level
  design document for the whole system.
- **ARCHITECTURE_DECISIONS.md** — the Architecture Decision Record (ADR) log.
- **CHANGELOG.md** — versioned history of this documentation set.
- **architecture/** — detailed architecture sub-documents (per subsystem).
- **diagrams/** — diagrams referenced by the Bible and architecture documents.

## Governance

- **Every future implementation must follow this Bible.** No feature, migration, engine, or
  operational change may be built that contradicts it.
- **Business decisions override engineering decisions.** When the two conflict, the business
  intent recorded here wins.
- **Engineering decisions must never violate the Product Bible.** Engineering choices live
  underneath the Bible and are constrained by it; if an engineering need appears to require
  breaking the Bible, the Bible must be amended first (via CHANGELOG + an ADR), not bypassed.
