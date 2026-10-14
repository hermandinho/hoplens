/**
 * A documented helper. The JSDoc must not move.
 */
export function documented(name: string) {
  // trailing comment
  return `hi ${name}`;
}

// Standalone comment between exports.

export const quickCheck = (x: unknown) => x != null;
