import { execFileSync } from "node:child_process";

function repository(): string | undefined {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  try {
    const origin = execFileSync("git", ["remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return origin.match(/(?:^https:\/\/github\.com\/|^git@github\.com:)([^/]+\/[^/]+?)(?:\.git)?$/)?.[1];
  } catch {
    return undefined;
  }
}

export const sourceRepository = repository();
