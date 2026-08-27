import type { SpaceOption } from "../api.js";

interface SpaceCardProps {
  readonly space: SpaceOption;
  readonly selected: boolean;
  readonly onToggle: (space: SpaceOption["id"]) => void;
}

export function SpaceCard({ space, selected, onToggle }: SpaceCardProps) {
  return (
    <label className={`space-card${selected ? " is-selected" : ""}`}>
      <input
        checked={selected}
        className="space-card__input"
        onChange={() => {
          onToggle(space.id);
        }}
        onKeyDown={(event) => {
          if (event.key === " " || event.key === "Enter") {
            event.preventDefault();
            onToggle(space.id);
          }
        }}
        type="checkbox"
      />
      <span className="space-card__check" aria-hidden="true">{selected ? "✓" : "+"}</span>
      <span className="space-card__content">
        <span className="space-card__name">{space.name}</span>
        <span className="space-card__description">{space.description}</span>
      </span>
    </label>
  );
}
