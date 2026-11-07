// A single-page app: the server answers every page with the one shell the
// build writes (index.html), which it fills in, and the browser renders it
// (hooks.client.ts starts it from what the server wrote).
export const ssr = false;
