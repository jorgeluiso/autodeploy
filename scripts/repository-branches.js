"use strict";

function assertValidBranch(branch, label) {
  if (
    typeof branch !== "string" ||
    branch.length === 0 ||
    branch.startsWith("-") ||
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.endsWith(".") ||
    branch.includes("..") ||
    branch.includes("//") ||
    branch.includes("@{") ||
    /[\x00-\x20~^:?*[\\]/.test(branch)
  ) {
    throw new Error(`${label} contains an invalid Git branch name`);
  }

  return branch;
}

function parseRepositoryBranches(rawValue) {
  if (!rawValue) return new Map();

  let parsed;
  try {
    parsed = JSON.parse(rawValue);
  } catch (error) {
    throw new Error(`REPOSITORY_BRANCHES must be valid JSON: ${error.message}`);
  }

  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("REPOSITORY_BRANCHES must be a JSON object");
  }

  return new Map(
    Object.entries(parsed).map(([repository, branch]) => {
      if (!/^[A-Za-z0-9._-]+$/.test(repository)) {
        throw new Error(`Invalid repository name in REPOSITORY_BRANCHES: ${repository}`);
      }

      return [repository, assertValidBranch(branch, `Branch for ${repository}`)];
    }),
  );
}

module.exports = { assertValidBranch, parseRepositoryBranches };
