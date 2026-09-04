/**
 * Unit tests for classifyLocation() in server/lib/graph.js — turning a
 * Settings → Sync location string into how Graph should address it. Pure,
 * no network.
 *
 *   npm run graph:test        (from server/)
 *   node --test scripts/graph-location.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");

process.env.GRAPH_ONEDRIVE_USER = "osola@hittbcn.com";
const { classifyLocation } = require("../lib/graph");

test("a plain string is a path", () => {
  assert.deepEqual(classifyLocation("HiITT Comuna 280217"), { kind: "path", path: "HiITT Comuna 280217" });
  assert.deepEqual(classifyLocation("/Clients/Projects/"), { kind: "path", path: "Clients/Projects" });
});

test("the OneDrive web-UI address of the configured user's folder becomes a path", () => {
  const url =
    "https://hittbcn-my.sharepoint.com/personal/osola_hittbcn_com/_layouts/15/onedrive.aspx" +
    "?id=%2Fpersonal%2Fosola%5Fhittbcn%5Fcom%2FDocuments%2FHiITT%20Comuna%20280217" +
    "&FolderCTID=0x012000BA4B9A5D2FC82F49B388AA9A74BB3116&view=0";
  assert.deepEqual(classifyLocation(url), { kind: "path", path: "HiITT Comuna 280217" });
});

test("the Documents root itself → empty path", () => {
  const url =
    "https://hittbcn-my.sharepoint.com/personal/osola_hittbcn_com/_layouts/15/onedrive.aspx" +
    "?id=%2Fpersonal%2Fosola%5Fhittbcn%5Fcom%2FDocuments";
  assert.deepEqual(classifyLocation(url), { kind: "path", path: "" });
});

test("a web-UI address for a different user's OneDrive throws", () => {
  const url =
    "https://hittbcn-my.sharepoint.com/personal/someoneelse_hittbcn_com/_layouts/15/onedrive.aspx" +
    "?id=%2Fpersonal%2Fsomeoneelse%5Fhittbcn%5Fcom%2FDocuments%2FFoo";
  assert.throws(() => classifyLocation(url), /configured for osola@hittbcn\.com/);
});

test("a team-site web-UI address throws with guidance", () => {
  const url =
    "https://hittbcn.sharepoint.com/sites/Projects/Shared%20Documents/Forms/AllItems.aspx" +
    "?id=%2Fsites%2FProjects%2FShared%20Documents%2FClients";
  assert.throws(() => classifyLocation(url), /Copy link/);
});

test("a real 'Copy link' sharing URL stays a share URL", () => {
  const url = "https://hittbcn-my.sharepoint.com/:f:/g/personal/osola_hittbcn_com/EjX8abc123";
  assert.deepEqual(classifyLocation(url), { kind: "share", url });
});
