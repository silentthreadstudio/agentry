// Search results page. Several things here could each be "the" bottleneck: it fetches the ENTIRE
// result set up front, filters client-side, has no pagination, and re-fetches + re-renders on every
// keystroke. Which one dominates load time is undiagnosed.

import React, { useEffect, useState } from "react";

export function SearchResults() {
  const [query, setQuery] = useState("");
  const [all, setAll] = useState([]);

  // Re-fetches the full, unpaginated result set on every keystroke.
  useEffect(() => {
    fetch("/api/search/results")
      .then((res) => res.json())
      .then((items) => setAll(items));
  }, [query]);

  // Filters the entire set client-side on every render.
  const visible = all.filter((item) =>
    item.title.toLowerCase().includes(query.toLowerCase()),
  );

  return (
    <div className="search-results">
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search…"
      />
      <ul>
        {visible.map((item) => (
          <li key={item.id}>{item.title}</li>
        ))}
      </ul>
    </div>
  );
}
