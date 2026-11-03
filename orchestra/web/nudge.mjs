// Notes are arriving and nothing sounds: the browser still waits for a tap, the system stopped the sound (a lock,
// a call) or another tab took it. Unless the listener stopped it here, a line where they are looking says which.
export function soundNudge({ notes, running, stopped, personal, watchOnly, listenShown, elsewhere }) {
  if (!notes || running || stopped || personal || watchOnly) return null;
  if (elsewhere) return "elsewhere";
  return listenShown ? null : "off";
}
