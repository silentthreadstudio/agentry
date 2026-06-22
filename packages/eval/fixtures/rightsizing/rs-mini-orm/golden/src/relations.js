// GOLDEN overlay — registers foreign keys via `link`; `canRemove` enforces referential integrity by checking
// every linked child table for a row whose FK column references the parent id. seed+golden PASSES the oracle.
function createRelations() {
  const links = []; // { childTable, column, parentTable }

  return {
    link(childTable, column, parentTable) {
      links.push({ childTable, column, parentTable });
    },
    canRemove(parentTable, parentId, db) {
      for (const link of links) {
        if (link.parentTable !== parentTable) continue;
        const child = db.table(link.childTable);
        const referenced = child.all().some((row) => row[link.column] === parentId);
        if (referenced) return false;
      }
      return true;
    },
  };
}

module.exports = { createRelations };
