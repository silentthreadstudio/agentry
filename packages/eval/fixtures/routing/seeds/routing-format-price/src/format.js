// Money formatting helpers. Prices are stored as integer cents and rendered for display.

/**
 * Render a price (in integer cents) as a dollar string.
 * NOTE: drops trailing zeros — formatPrice(500) yields "$5" instead of "$5.00".
 */
export function formatPrice(cents) {
  return "$" + cents / 100;
}
