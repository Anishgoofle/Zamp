import type { Conflict } from '@engine';
import { describeConflict, type NameLookup } from '../lib/describe';
import { ChangeList } from './ChangeList';

type Side = 'ours' | 'theirs';

interface Props {
  conflicts: readonly Conflict[];
  /** Keyed by conflict id. */
  picks: Record<string, Side>;
  onPick: (conflict: Conflict, side: Side) => void;
  names: NameLookup;
}

export function ConflictResolver({ conflicts, picks, onPick, names }: Props) {
  if (conflicts.length === 0) {
    return <p className="ok">No conflicts — every change reconciled automatically.</p>;
  }
  return (
    <div className="conflicts">
      {conflicts.map((conflict) => {
        const { where, blurb } = describeConflict(conflict, names);
        const picked = picks[conflict.id];
        return (
          <div className={picked ? 'conflict resolved' : 'conflict'} key={conflict.id}>
            <div className="conflict-head">
              <strong>{where}</strong>
              <span className="tag">{conflict.kind}</span>
              {picked && <span className="tag pick-tag">took {picked}</span>}
            </div>
            <p className="muted">{blurb}</p>
            {/* A radio group, not two buttons: picking a side is one choice of two,
                and a <label> may contain the change list where a <button> may not. */}
            <div className="sides" role="radiogroup" aria-label={where}>
              {(['ours', 'theirs'] as const).map((side) => (
                <label
                  key={side}
                  data-side={side}
                  className={picked === side ? 'side selected' : 'side'}
                >
                  <input
                    type="radio"
                    className="visually-hidden"
                    name={conflict.id}
                    checked={picked === side}
                    onChange={() => onPick(conflict, side)}
                  />
                  <span className="side-label">
                    {picked === side ? '✓ ' : ''}
                    Take {side}
                  </span>
                  <ChangeList
                    changes={conflict[side]}
                    names={names}
                    empty="(no change on this side)"
                  />
                </label>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
