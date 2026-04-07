# Manifest UI Principles

Manifest should feel like a **thoughtful modern desktop app**, not a direct visual continuation of Archon.

The UI should preserve the strengths of structured editing and history awareness while becoming calmer, clearer, and more inviting.

---

## Core principles

### 1. Calm over clutter
The interface should reduce noise and surface complexity progressively.

### 2. Structure should feel spatial
Hierarchy, relationships, and history should feel easy to scan and navigate.

### 3. The default state should be beautiful
An empty project, a half-built project, and a mature project should all feel considered.

### 4. History should feel approachable
Snapshots, diffs, and restore actions should feel like natural parts of the product, not specialist tools.

### 5. Power should be present, not oppressive
Keyboard support, quick actions, and advanced panels should exist, but they should not dominate the default experience.

---

## Visual direction

Manifest should lean toward:

- strong typographic hierarchy
- restrained color usage
- comfortable spacing
- crisp, modern panels and inspectors
- subtle motion and transitions
- clear selected, focused, and changed states

It should avoid:

- overly dense enterprise layouts
- too many persistent toolbars and chrome elements
- visually loud status indicators everywhere
- “developer tool” aesthetics unless deliberately invoked

---

## Layout guidance

A likely v1 shell:

- **left:** hierarchy / navigation
- **center:** primary content or editor view
- **right:** inspector, metadata, or history context
- **top or command area:** search, quick actions, global navigation

The layout should support depth without feeling cramped.

---

## Svelte + Tailwind implications

- build a small, opinionated component system early
- prefer shared tokens for spacing, color, radius, and shadows
- avoid ad hoc styling drift across panels and dialogs
- design empty states and loading states as first-class screens

---

## UX benchmark for v1

A new user should be able to open Manifest and immediately feel:

- “I understand the shape of this app.”
- “My work is safe here.”
- “This feels lighter and more polished than a typical internal tool.”

That emotional read matters as much as raw feature count.
