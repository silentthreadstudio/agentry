// The Agentry plugin package for OpenCode: the board group as two native tools (`agentry_board`
// read, `agentry_board_write`) over the in-process seam in `src/run.mjs`. It imports nothing from
// the host; the registration contract is sniffed at setup so an unfamiliar shape registers nothing
// instead of breaking the service. The lane and mem groups register with their own slice.
import { boardRead, boardWrite } from "./src/tools/board.mjs";

// The tool-add call to use, from the shapes the host is documented to offer, deepest first: the
// tool domain's transform may already carry the editor, or be the call itself, or the tool domain
// may be one. Null when nothing matches — an unknown host shape registers no tools at all.
function toolsApi(ctx) {
  const tool = ctx?.tool;
  const editor = tool?.transform?.editor;
  if (typeof editor?.add === "function") return (registration) => editor.add(registration);
  if (typeof tool?.transform === "function") return (registration) => tool.transform(registration);
  if (typeof tool === "function") return (registration) => tool(registration);
  return null;
}

export const Plugin = {
  id: "agentry-opencode",
  async setup(ctx) {
    const add = toolsApi(ctx);
    if (!add) return;
    for (const registration of [boardRead, boardWrite]) await add(registration);
  },
};
