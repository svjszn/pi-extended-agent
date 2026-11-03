#!/usr/bin/env node
// The build emits this launcher at bin/pi.mjs to preserve existing npm links.
await import(new URL("../dist/bin/main.js", import.meta.url).href);
