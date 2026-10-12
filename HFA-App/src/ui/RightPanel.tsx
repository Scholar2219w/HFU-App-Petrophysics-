import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** Modules render their Properties/Parameters/Statistics into the right panel. */
export function RightPanel({ children }: { children: ReactNode }) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  useEffect(() => { setEl(document.getElementById('right-slot')); }, []);
  return el ? createPortal(children, el) : null;
}
