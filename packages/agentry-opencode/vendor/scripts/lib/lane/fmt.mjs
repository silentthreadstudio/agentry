// fmt — the small forms the lane commands record and print: a commit as its short sha, a time as an
// ISO string, git's output as its first line.
export const short = (sha) => String(sha ?? "").slice(0, 7);
export const now = () => new Date().toISOString();
// The first line of a command's output, trimmed ("" for none).
export const first = (text) => text.trim().split("\n")[0] ?? "";
