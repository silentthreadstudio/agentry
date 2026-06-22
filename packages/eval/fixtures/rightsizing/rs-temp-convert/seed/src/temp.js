// celsiusToF(c) — convert Celsius to Fahrenheit.
//
// PLANTED BUG: the formula forgets the `+ 32` offset, so it returns c*9/5 instead of c*9/5+32.
function celsiusToF(c) {
  return (c * 9) / 5; // BUG: missing `+ 32`.
}

module.exports = { celsiusToF };
