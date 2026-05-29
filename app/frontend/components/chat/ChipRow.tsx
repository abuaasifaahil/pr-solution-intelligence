'use client';
import type { ChipDef } from '../../lib/chats';

interface Props {
  chips: ChipDef[];
  onPick: (chip: ChipDef) => void;
  disabled?: boolean;
}

export function ChipRow({ chips, onPick, disabled }: Props) {
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 pl-10">
      {chips.map((chip) => (
        <button
          key={chip.value}
          onClick={() => onPick(chip)}
          disabled={disabled}
          className="px-3 py-1.5 text-[0.82rem] font-medium rounded-pill
                     bg-win-blue-50 text-win-blue-600 hover:bg-win-blue-100
                     border border-win-blue-100 transition
                     disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {chip.label}
        </button>
      ))}
    </div>
  );
}
