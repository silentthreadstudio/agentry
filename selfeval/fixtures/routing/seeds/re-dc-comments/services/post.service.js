// Post service: business logic over the post model. A comment service would mirror this — wrapping a
// comment model and enqueuing moderation work for each new comment.

import { createPost, getPost, allPosts } from "../models/post.js";

export function publishPost(input) {
  return createPost(input);
}

export function findPost(id) {
  return getPost(id);
}

export function listPosts() {
  return allPosts();
}
