# What Manifest Should Rethink from Archon

This document lists the areas where Manifest should deliberately **avoid inheriting Archon’s assumptions by default**.

| Topic | Why Archon did it | Manifest stance |
|---|---|---|
| Wails + Go backend | Good fit for Archon’s original architecture | Replace with Electron + TypeScript to simplify the stack and unify app code |
| Hybrid Git implementation | Helpful for performance, LFS, and credential handling | Start much simpler; only add complexity if clearly necessary |
| Large early scope | Archon aimed at a broad, powerful platform | Keep Manifest v1 sharply focused |
| Full semantic merge ambition | Differentiated, but heavy to implement well | Defer advanced merge until after snapshots and diff UX are solid |
| Broad plugin surface | Strategically valuable, but expensive to stabilize | Treat as a later-stage capability |
| CLI surface area | Useful for automation, but not essential to the desktop product story | Desktop-first; CLI only if a real use case emerges |
| Heavy upfront ADR footprint | Good for a mature architecture effort | Keep the initial decision set smaller and more fluid |
| Architecture choices inherited from old constraints | Rational in context, but not automatically right now | Re-justify every major subsystem from first principles |

---

## Practical rules for avoiding accidental carryover

- Do not port code just because it already exists.
- Do not preserve complexity without re-stating the problem it solves.
- Do not assume Manifest must expose every Archon concept in v1.
- Do not mistake “feature parity” for “product progress.”

---

## Summary judgment

Manifest should feel like a **confident reset**, not an obligation-driven rewrite.

If a piece of Archon does not clearly serve the new product vision, it should be redesigned, deferred, or dropped.
