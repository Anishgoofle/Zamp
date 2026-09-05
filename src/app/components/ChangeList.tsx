import type { Change } from '@engine';
import { changeSign, describeChange, type NameLookup } from '../lib/describe';

const MARK = { add: '+', drop: '−', modify: '~' } as const;

export function ChangeList({
  changes,
  names,
  empty,
}: {
  changes: readonly Change[];
  names: NameLookup;
  empty: string;
}) {
  if (changes.length === 0) return <p className="muted">{empty}</p>;
  return (
    <ul className="change-list">
      {changes.map((change, i) => {
        const sign = changeSign(change);
        return (
          <li key={i} data-sign={sign}>
            <span className="change-mark">{MARK[sign]}</span>
            {describeChange(change, names)}
          </li>
        );
      })}
    </ul>
  );
}
