// yaml-fold — line folding for the YAML writer: keep text within a line width by splitting at spaces,
// as the `yaml` package does (its foldFlowLines, same limits: 80 columns, 20 minimum content). The store
// has always written its frontmatter with that package; folding the same way keeps a rewritten file
// byte-identical to the one the old writer left. Pure.
//
// fold(text, indent, mode, { indentAtStart, onOverflow? }) -> string
//   mode "flow" (plain and single-quoted), "quoted" (double-quoted: a fold in the middle of a word is
//   a backslash and a line break), "block" (the folded `>` scalar)

const LINE_WIDTH = 80;
const MIN_CONTENT = 20;

// Presumes `i + 1` is at the start of a line: the index of the last newline in the more-indented block.
function consumeMoreIndentedLines(text, from, indent) {
  let i = from;
  let end = from;
  let start = from + 1;
  let ch = text[start];
  while (ch === " " || ch === "\t") {
    if (i < start + indent) {
      i += 1;
      ch = text[i];
    } else {
      do {
        i += 1;
        ch = text[i];
      } while (ch && ch !== "\n");
      end = i;
      start = i + 1;
      ch = text[start];
    }
  }
  return end;
}

export function fold(text, indent, mode, { indentAtStart, onOverflow } = {}) {
  const endStep = Math.max(1 + MIN_CONTENT, 1 + LINE_WIDTH - indent.length);
  if (text.length <= endStep) return text;
  const folds = [];
  const escapedFolds = {};
  let end = LINE_WIDTH - indent.length;
  if (typeof indentAtStart === "number") {
    if (indentAtStart > LINE_WIDTH - Math.max(2, MIN_CONTENT)) folds.push(0);
    else end = LINE_WIDTH - indentAtStart;
  }
  let split;
  let prev;
  let overflow = false;
  let i = -1;
  let escStart = -1;
  let escEnd = -1;
  if (mode === "block") {
    i = consumeMoreIndentedLines(text, i, indent.length);
    if (i !== -1) end = i + endStep;
  }
  for (;;) {
    i += 1;
    let ch = text[i];
    if (ch === undefined) break;
    if (mode === "quoted" && ch === "\\") {
      escStart = i;
      switch (text[i + 1]) {
        case "x":
          i += 3;
          break;
        case "u":
          i += 5;
          break;
        case "U":
          i += 9;
          break;
        default:
          i += 1;
      }
      escEnd = i;
    }
    if (ch === "\n") {
      if (mode === "block") i = consumeMoreIndentedLines(text, i, indent.length);
      end = i + indent.length + endStep;
      split = undefined;
    } else {
      if (ch === " " && prev && prev !== " " && prev !== "\n" && prev !== "\t") {
        // a space between two non-spaces can become a line break
        const next = text[i + 1];
        if (next && next !== " " && next !== "\n" && next !== "\t") split = i;
      }
      if (i >= end) {
        if (split) {
          folds.push(split);
          end = split + endStep;
          split = undefined;
        } else if (mode === "quoted") {
          // white space collected at the end may stretch past the line width
          while (prev === " " || prev === "\t") {
            prev = ch;
            i += 1;
            ch = text[i];
            overflow = true;
          }
          // account for the newline escape, but don't break the escape before it
          const j = i > escEnd + 1 ? i - 2 : escStart - 1;
          if (escapedFolds[j]) return text;
          folds.push(j);
          escapedFolds[j] = true;
          end = j + endStep;
          split = undefined;
        } else {
          overflow = true;
        }
      }
    }
    prev = ch;
  }
  if (overflow && onOverflow) onOverflow();
  if (folds.length === 0) return text;
  let res = text.slice(0, folds[0]);
  for (let k = 0; k < folds.length; ++k) {
    const at = folds[k];
    const to = folds[k + 1] || text.length;
    if (at === 0) res = `\n${indent}${text.slice(0, to)}`;
    else {
      if (mode === "quoted" && escapedFolds[at]) res += `${text[at]}\\`;
      res += `\n${indent}${text.slice(at + 1, to)}`;
    }
  }
  return res;
}
