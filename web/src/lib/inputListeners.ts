// Listeners at the window for every kind of input (DESIGN §29, "On the iPad"): they do nothing.
//
// On an iPad Pro (Safari, Apple Pencil) the page got no pointer or touch events at all for 8–16 s at a time while the
// student wrote — nothing reached the page, pointer ids did not advance — until the tab was left and entered again.
// With the debug overlay's listeners at the window (passive, capture phase, for the events below) 245 strokes in a row
// arrived without a gap; without them the dead periods were there. Why is not known (WebKit decides per region
// whether and how it sends touches to the page; listeners at the window make the whole page one region), so the
// listeners stay while a viewer is mounted. They cost nothing: passive, no work.
const EVENTS = [
  'pointerdown',
  'pointermove',
  'pointerup',
  'pointercancel',
  'gotpointercapture',
  'lostpointercapture',
  'touchstart',
  'touchmove',
  'touchend',
  'touchcancel',
  'mousedown',
  'mouseup',
  'gesturestart',
  'gestureend',
] as const;

const nothing = () => {};
const OPTIONS = { capture: true, passive: true } as const;
let holders = 0;

/** Keeps the listeners at the window while at least one caller holds them; returns what lets go. */
export function holdInputListeners(target: Pick<Window, 'addEventListener' | 'removeEventListener'> = window): () => void {
  if (holders++ === 0) for (const type of EVENTS) target.addEventListener(type, nothing, OPTIONS);
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    if (--holders === 0) for (const type of EVENTS) target.removeEventListener(type, nothing, OPTIONS);
  };
}

export const INPUT_LISTENER_EVENTS: readonly string[] = EVENTS;
