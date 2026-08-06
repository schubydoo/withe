'use client';

import { useState } from 'react';

/** Copy in one action, with a fallback for browsers that refuse the clipboard. */
export function CopyButton({ text }: { text: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  return (
    <button
      type="button"
      className="rounded border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-100"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setState('copied');
          setTimeout(() => setState('idle'), 2000);
        } catch {
          // Clipboard access needs a secure context, and Withe is often served
          // over plain HTTP on a LAN. Say so instead of failing silently.
          setState('failed');
        }
      }}
    >
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Select it and copy by hand' : 'Copy'}
    </button>
  );
}
