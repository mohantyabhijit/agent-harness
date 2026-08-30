import type { SpaceOption } from "../api.js";

interface SpaceCardProps {
  readonly space: SpaceOption;
  readonly onSelect: (space: SpaceOption["id"]) => void;
}

export function SpaceCard({ space, onSelect }: SpaceCardProps) {
  return (
    <button className="space-card" onClick={() => { onSelect(space.id); }} type="button">
      <span className="space-card__check" aria-hidden="true">→</span>
      <span className="space-card__content">
        <span className="space-card__name">{space.name}</span>
        <span className="space-card__description">{space.description}</span>
      </span>
    </button>
  );
}
