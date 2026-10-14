interface SkeletonProps {
  lines?: number;
  /** Rough % variability so the strips look organic. */
  varyWidth?: boolean;
}

/** Low-key animated placeholder for lists before the first fetch returns. */
export function Skeleton({ lines = 5, varyWidth = true }: SkeletonProps) {
  return (
    <div class="skeleton" aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => {
        const width = 55 + ((i * 13) % 40);
        return (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: pure decorative placeholder, no identity
            key={`skel-${i}`}
            class="skeleton-row"
            style={varyWidth ? `width: ${width}%` : undefined}
          />
        );
      })}
    </div>
  );
}
