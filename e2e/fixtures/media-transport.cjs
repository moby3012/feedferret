// Test-process-only transport mapping. Production code retains full SSRF
// checks: the synthetic host resolves publicly, then this preload redirects
// ONLY its exact image request to the local fixture. Never shipped by Docker.
const dns = require("node:dns/promises");
const lookup = dns.lookup;
dns.lookup = async function (hostname, options) {
  if (hostname === "media.fixture.example") return options?.all ? [{ address: "8.8.8.8", family: 4 }] : { address: "8.8.8.8", family: 4 };
  return lookup.call(this, hostname, options);
};
const undici = require("undici");
const fetch = undici.fetch;
undici.fetch = function (url, options) {
  if (String(url) === "http://media.fixture.example/e4.png") {
    const target = `http://127.0.0.1:${process.env.E2E_FIXTURE_PORT || 4010}/e4.png`;
    const { dispatcher, ...init } = options || {};
    return fetch(target, init);
  }
  return fetch(url, options);
};
