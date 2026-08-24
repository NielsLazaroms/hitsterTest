/**
 * Detects the embedded browsers that chat apps open links in.
 *
 * These are WebViews, not browser tabs, and they break this app in two ways
 * that are hard to tell apart from a bug: the camera is refused outright, and
 * the Spotify round trip loses the PKCE verifier stored before leaving, so
 * sign-in silently fails and the app reports itself as not connected.
 *
 * Detection is a best guess from the user agent, so it drives a warning and
 * never blocks anything: a false positive costs a dismissible sentence, and a
 * false negative leaves things exactly as they are today.
 */

/** Named in-app browsers that identify themselves. */
const NAMED =
  /FBAN|FBAV|FB_IAB|Instagram|Line\/|Twitter|Snapchat|LinkedInApp|Pinterest|MicroMessenger|WhatsApp/i;

export function isInAppBrowser(agent: string = navigator.userAgent): boolean {
  if (NAMED.test(agent)) return true;

  // Android WebViews mark themselves "wv" where a real Chrome does not.
  if (/Android/.test(agent) && /;\s*wv\)/.test(agent)) return true;

  /*
   * On iOS every browser is WebKit, so the tell is the absence of a marker
   * rather than the presence of one: a genuine Safari tab ends its agent with
   * "Safari/...", and Chrome and Firefox add CriOS or FxiOS. An embedded view
   * has none of the three.
   */
  const ios = /iPhone|iPad|iPod/.test(agent);
  return ios && !/Safari\//.test(agent) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(agent);
}
