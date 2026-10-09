import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ForgeMarkdown } from "@/components/ForgeMarkdown";
import type { CommitSummary } from "@/ipc/types";
import { resolveCommitRef, splitCommitRefs } from "./commit-refs";

function commit(sha: string, summary = "a change"): CommitSummary {
  return {
    sha,
    shortSha: sha.slice(0, 7),
    summary,
    message: summary,
    author: "dev",
    time: 0,
    merge: false,
    stats: { filesChanged: 1, insertions: 1, deletions: 0 },
  };
}

const A = commit("abc1234def5678900000000000000000000000aa", "add login");
const B = commit("abc1299000000000000000000000000000000bbb", "fix logout");
const COMMITS = [A, B];

describe("resolveCommitRef", () => {
  it("resolves a unique prefix, case-insensitively", () => {
    expect(resolveCommitRef("abc1234", COMMITS)).toBe(A);
    expect(resolveCommitRef("ABC1299", COMMITS)).toBe(B);
    expect(resolveCommitRef(A.sha, COMMITS)).toBe(A);
  });

  it("refuses ambiguous and unknown hashes", () => {
    expect(resolveCommitRef("abc12", COMMITS)).toBeNull();
    expect(resolveCommitRef("deadbeef", COMMITS)).toBeNull();
  });
});

describe("splitCommitRefs", () => {
  it("splits out only hashes that resolve", () => {
    const parts = splitCommitRefs("Committed abc1234; see #ff00ff00 and deadbeef.", (t) =>
      resolveCommitRef(t, COMMITS),
    );
    expect(parts).toEqual([
      { text: "Committed " },
      { text: "abc1234", commit: A },
      { text: "; see #ff00ff00 and deadbeef." },
    ]);
  });

  it("leaves hex inside longer words alone", () => {
    expect(splitCommitRefs("xabc1234", (t) => resolveCommitRef(t, COMMITS))).toEqual([
      { text: "xabc1234" },
    ]);
  });
});

describe("ForgeMarkdown commit refs", () => {
  it("links listed hashes in prose and inline code, not in code blocks", async () => {
    const onOpen = vi.fn();
    render(
      <ForgeMarkdown
        source={"Committed abc1234 and `abc1299`, not deadbeef.\n\n```\nabc1234\n```"}
        codeBlocks
        commitRefs={{ commits: COMMITS, onOpen }}
      />,
    );
    const links = screen.getAllByRole("button", { name: /^abc12/ });
    expect(links.map((l) => l.textContent)).toEqual(["abc1234", "abc1299"]);
    await userEvent.click(links[1]);
    expect(onOpen).toHaveBeenCalledWith(B);
    expect(screen.queryByRole("button", { name: "deadbeef" })).toBeNull();
  });
});
