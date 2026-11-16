// Run mode. With the Node server (npm start) the UI talks to /api/converters.
// The GitHub Pages build (scripts/build-pages.js) replaces this file with
// { mode: 'static', converters: [...] } so the browser calls converters directly.
window.CONV_HOUSE = { mode: 'server' };
