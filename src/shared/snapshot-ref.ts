// A "snapshot ref" in the compare/report APIs is normally a saved snapshot's
// name. CURRENT_PROJECT_REF is a sentinel that means "the live, in-memory
// current project" instead of a saved snapshot — used so the user can compare
// what they have right now against a snapshot ("what changed since my last
// snapshot?") without first creating a throwaway snapshot.
//
// The value is deliberately impossible as a real snapshot name:
// validateSnapshotName allows only [A-Za-z0-9._-], so the leading `@` can never
// collide with a user's snapshot. This lets the sentinel flow through the
// existing string-typed loadCompare/compare/report APIs with no signature
// changes.
export const CURRENT_PROJECT_REF = '@current'

// Human-facing label for the current-project side of a comparison.
export const CURRENT_PROJECT_LABEL = 'Current project'

export function isCurrentRef(ref: string): boolean {
  return ref === CURRENT_PROJECT_REF
}

// Display label for a snapshot ref: the sentinel renders as the friendly label,
// any other ref renders as itself (the snapshot name).
export function snapshotRefLabel(ref: string): string {
  return isCurrentRef(ref) ? CURRENT_PROJECT_LABEL : ref
}
