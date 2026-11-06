// shell — text as a word for a command a person or agent pastes into a POSIX shell. Shared by the board
// (drift's suggested commands) and the lanes (briefs, refusals, cleanup steps). Pure.
//
// shellQuote(text) -> text single-quoted, each `'` written `'\''`
// shellWord(text)  -> text as it is when plain, else `shellQuote(text)`

/** `text` as one POSIX shell word: single-quoted, each `'` written `'\''`. */
export const shellQuote = (text) => `'${String(text).replace(/'/g, "'\\''")}'`;

/** `text` as one shell word for a command a person or agent pastes: as it is when it holds only plain
 *  characters, else single-quoted (`shellQuote`). */
export const shellWord = (text) =>
  /^[\w./@%+=:,-]+$/.test(String(text)) ? String(text) : shellQuote(text);
