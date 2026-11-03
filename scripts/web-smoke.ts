import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
// Exercise the installed executable and shipped assets, with the release fixture profile.
const installed = process.argv[2]; assert.ok(installed);
const child = spawn(process.execPath, [join(installed, "bin/pi.mjs"), "ui", "--no-open"], { stdio: "pipe", windowsHide: true });
try {
  const url = await new Promise<string>((accept, reject) => {
    let output = "";
    const timer = setTimeout(() => { reject(new Error("Installed dashboard did not become ready.")); }, 15_000);
    child.stdout.setEncoding("utf8"); child.stderr.resume();
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("exit", () => { clearTimeout(timer); reject(new Error("Installed dashboard exited before becoming ready.")); });
    child.stdout.on("data", chunk => {
      output += chunk; const match = /http:\/\/127\.0\.0\.1:\d+\/#[-_A-Za-z0-9]+/.exec(output);
      if (match) { clearTimeout(timer); accept(match[0]); }
    });
  });
  const address = new URL(url), headers = { Authorization: `Bearer ${address.hash.slice(1)}` };
  assert.match(await (await fetch(address.origin)).text(), /New chat/);
  for (const asset of ["app.js", "lib/web-types.js", "style.css", "pi.svg"]) assert.equal((await fetch(`${address.origin}/${asset}`)).status, 200, `Missing installed dashboard asset: ${asset}`);
  assert.equal((await fetch(`${address.origin}/api/overview`)).status, 401);
  const response = await fetch(`${address.origin}/api/overview`, { headers }); assert.equal(response.status, 200);
  const overview = await response.json(); assert.ok(Array.isArray(overview.chats));
  assert.equal((await fetch(`${address.origin}/api/overview`, { headers: { ...headers, Origin: "https://example.invalid" } })).status, 403);
  console.log("Installed dashboard: local CLI, assets, authorized history and origin checks passed.");
} finally {
  if (child.exitCode === null) await new Promise<void>(accept => { child.once("close", () => accept()); child.kill("SIGTERM"); });
}
