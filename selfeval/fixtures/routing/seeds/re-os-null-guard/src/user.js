'use strict';

// A user record looks like:
//   { email: 'a@b.com', profile: { firstName, lastName } }
// profile is optional: users created via the invite flow have no profile yet.

function getDisplayName(user) {
  return user.profile.firstName + ' ' + user.profile.lastName;
}

function getInitials(user) {
  const name = getDisplayName(user);
  return name
    .split(' ')
    .map((part) => part.charAt(0).toUpperCase())
    .join('');
}

module.exports = { getDisplayName, getInitials };
