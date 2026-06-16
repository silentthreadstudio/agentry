let current = 50;

function setVolume(n) {
  current = n;
  return current;
}

function getVolume() {
  return current;
}

module.exports = { setVolume, getVolume };
