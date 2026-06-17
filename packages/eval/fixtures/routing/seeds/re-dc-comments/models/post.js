// Post model: an in-memory store. This is the existing domain; a comment model would sit alongside
// it (comments reference a postId), following the same shape.

const posts = new Map();

export function createPost({ id, authorId, body }) {
  const post = { id, authorId, body, createdAt: Date.now() };
  posts.set(id, post);
  return post;
}

export function getPost(id) {
  return posts.get(id);
}

export function allPosts() {
  return [...posts.values()];
}
