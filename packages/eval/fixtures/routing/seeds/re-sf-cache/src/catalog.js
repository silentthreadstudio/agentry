'use strict';

const { query } = require('./db');

// Products change when merchandisers edit price/stock. A stale read here
// shows a wrong price at checkout.
async function getProduct(id) {
  const rows = await query('SELECT * FROM products WHERE id = ?', [id]);
  return rows[0] || null;
}

async function updateProduct(id, fields) {
  await query('UPDATE products SET ? WHERE id = ?', [fields, id]);
  return getProduct(id);
}

async function listProducts() {
  return query('SELECT * FROM products ORDER BY id', []);
}

module.exports = { getProduct, updateProduct, listProducts };
