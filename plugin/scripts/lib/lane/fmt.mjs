// fmt — the two small forms the lane commands record and print: a commit as its short sha, a time as
// an ISO string.
export const short = (sha) => String(sha ?? "").slice(0, 7);
export const now = () => new Date().toISOString();
