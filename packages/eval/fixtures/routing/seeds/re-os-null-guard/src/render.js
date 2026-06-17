'use strict';

const { getDisplayName } = require('./user');

// Renders a user row for the members list.
function renderUserRow(user) {
  return '<li>' + getDisplayName(user) + '</li>';
}

module.exports = { renderUserRow };
