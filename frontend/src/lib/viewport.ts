/** Apply zoom restrictions only on touch-first devices, regardless of window width. */
export function configureMobileViewport() {
  const mobile = window.matchMedia('(hover: none) and (pointer: coarse)');
  const viewport = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  const defaultContent = viewport?.content ?? 'width=device-width, initial-scale=1.0';
  let locked = false;

  const cancelGesture = (event: Event) => {
    if (event.cancelable) event.preventDefault();
  };
  const cancelPinch = (event: TouchEvent) => {
    // Embedded maps still receive their touch events.
    if (event.touches.length > 1 && event.cancelable) event.preventDefault();
  };
  const removeGuards = () => {
    document.removeEventListener('gesturestart', cancelGesture);
    document.removeEventListener('gesturechange', cancelGesture);
    document.removeEventListener('touchmove', cancelPinch);
  };
  const sync = () => {
    viewport?.setAttribute(
      'content',
      mobile.matches
        ? `${defaultContent}, minimum-scale=1.0, maximum-scale=1.0, user-scalable=no`
        : defaultContent,
    );
    if (locked === mobile.matches) return;
    locked = mobile.matches;
    if (locked) {
      document.addEventListener('gesturestart', cancelGesture, { passive: false });
      document.addEventListener('gesturechange', cancelGesture, { passive: false });
      document.addEventListener('touchmove', cancelPinch, { passive: false });
    } else {
      removeGuards();
    }
  };
  mobile.addEventListener('change', sync);
  sync();

  import.meta.hot?.dispose(() => {
    mobile.removeEventListener('change', sync);
    removeGuards();
    viewport?.setAttribute('content', defaultContent);
  });
}
