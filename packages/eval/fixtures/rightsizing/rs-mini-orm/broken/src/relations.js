// BROKEN overlay — link registers FKs, but canRemove NEVER checks the child tables: it always returns true, so
// referential integrity is not enforced and a referenced parent can be removed, orphaning its children.
// seed+broken FAILS the oracle.
function createRelations() {
  const links = [];

  return {
    link(childTable, column, parentTable) {
      links.push({ childTable, column, parentTable });
    },
    canRemove(parentTable, parentId, db) {
      // BUG: no referential-integrity check — always returns true even when a child row references parentId,
      // so a referenced parent is removed and its children are orphaned.
      return true;
    },
  };
}

module.exports = { createRelations };
