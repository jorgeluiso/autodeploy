"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { assertValidBranch, parseRepositoryBranches } = require("./repository-branches");

test("parses per-repository deployment branches", () => {
  const branches = parseRepositoryBranches(
    '{"porter":"production","autodeploy":"main","site":"releases/live"}',
  );

  assert.equal(branches.get("porter"), "production");
  assert.equal(branches.get("autodeploy"), "main");
  assert.equal(branches.get("site"), "releases/live");
});

test("returns an empty map when no mapping is configured", () => {
  assert.deepEqual(parseRepositoryBranches(undefined), new Map());
});

test("rejects malformed configuration", () => {
  assert.throws(() => parseRepositoryBranches("porter=production"), /valid JSON/);
  assert.throws(() => parseRepositoryBranches("[]"), /JSON object/);
  assert.throws(
    () => parseRepositoryBranches('{"../porter":"production"}'),
    /Invalid repository name/,
  );
});

test("rejects unsafe branch names", () => {
  for (const branch of ["", "-production", "production..old", "release lock", "main~1"]) {
    assert.throws(() => assertValidBranch(branch, "Test branch"), /invalid Git branch/);
  }
});
