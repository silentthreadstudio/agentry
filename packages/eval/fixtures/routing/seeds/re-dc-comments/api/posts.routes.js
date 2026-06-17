// REST routes for posts. Comment endpoints (list comments on a post + post a new comment) would
// register here the same way these routes do.

import { publishPost, findPost, listPosts } from "../services/post.service.js";

export function registerPostRoutes(router) {
  router.post("/posts", (req, res) => {
    const post = publishPost(req.body);
    res.status(201).json(post);
  });

  router.get("/posts", (_req, res) => {
    res.status(200).json(listPosts());
  });

  router.get("/posts/:id", (req, res) => {
    const post = findPost(req.params.id);
    if (!post) return res.status(404).json({ error: "not found" });
    res.status(200).json(post);
  });
}
