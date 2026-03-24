import * as fs from "fs";

const MARKER = "<!-- emit-catalog-check -->";

interface GitHubEventPayload {
  pull_request?: {
    number: number;
  };
  repository?: {
    full_name: string;
  };
}

function getEventPayload(): GitHubEventPayload {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) throw new Error("GITHUB_EVENT_PATH not set — not running in GitHub Actions?");
  return JSON.parse(fs.readFileSync(eventPath, "utf8"));
}

function getRepoSlug(): string {
  // GITHUB_REPOSITORY is "owner/repo"
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) throw new Error("GITHUB_REPOSITORY not set");
  return repo;
}

async function githubApi(path: string, options: RequestInit = {}): Promise<any> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN not set");

  const url = `https://api.github.com${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.v3+json",
      "Content-Type": "application/json",
      ...(options.headers as Record<string, string> | undefined),
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub API ${res.status}: ${body}`);
  }

  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/**
 * Create or update the emit PR comment.
 * Finds an existing comment by the hidden HTML marker and updates it,
 * or creates a new one if none exists.
 */
export async function postOrUpdateComment(body: string): Promise<void> {
  const payload = getEventPayload();
  const prNumber = payload.pull_request?.number;
  if (!prNumber) {
    console.log("Not a pull_request event — skipping comment.");
    return;
  }

  const repo = getRepoSlug();
  const commentsPath = `/repos/${repo}/issues/${prNumber}/comments`;

  // Paginate to find existing comment with marker
  let existingCommentId: number | null = null;
  let page = 1;
  while (!existingCommentId) {
    const comments = await githubApi(`${commentsPath}?per_page=100&page=${page}`);
    if (!Array.isArray(comments) || comments.length === 0) break;
    for (const c of comments) {
      if (typeof c.body === "string" && c.body.includes(MARKER)) {
        existingCommentId = c.id;
        break;
      }
    }
    if (comments.length < 100) break;
    page++;
  }

  if (existingCommentId) {
    await githubApi(`/repos/${repo}/issues/comments/${existingCommentId}`, {
      method: "PATCH",
      body: JSON.stringify({ body }),
    });
    console.log(`Updated existing comment #${existingCommentId}`);
  } else {
    await githubApi(commentsPath, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
    console.log("Created new PR comment");
  }
}
