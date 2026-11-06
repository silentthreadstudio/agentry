// The Agentry plugin package for OpenCode: the six native tools (the board, lane and mem groups,
// reads and drives split so permission rules can name them) over the in-process seam in `src/run.mjs`.
// It imports nothing from the host; the registration contract is the host's own documented one
// (v2 docs, building/plugins/server): `ctx.tool.transform((editor) => {…})` with `editor.namespace`
// and `editor.add(tool)`, each tool carrying `options: { namespace, codemode }`.
import { boardRead, boardWrite } from "./src/tools/board.mjs";
import { laneDrive, laneRead } from "./src/tools/lane.mjs";
import { memRead, memWrite } from "./src/tools/mem.mjs";

const REGISTRATIONS = [boardRead, boardWrite, laneRead, laneDrive, memRead, memWrite];
export const NAMESPACE = "agentry";
export const NAMESPACE_DESCRIPTION =
  "Reads and decides against the repo's own Agentry state - the board, the build lanes, the memory store";

export const Plugin = {
  id: "agentry-opencode",
  async setup(ctx) {
    const transform = ctx?.tool?.transform;
    if (typeof transform !== "function") return; // an unfamiliar host shape registers nothing
    // The service process's cwd is not the workspace (measured live, this project's Q4 probe): the
    // tools default their root to the location whose config loaded this plugin, and a session may
    // always pass an explicit one.
    const boundRoot = ctx?.location?.directory ?? ctx?.location?.project?.canonical;
    const permission = ctx?.permission;
    const assertable = typeof permission?.assert === "function";
    await transform((editor) => {
      if (typeof editor?.namespace === "function")
        editor.namespace({ name: NAMESPACE, description: NAMESPACE_DESCRIPTION });
      for (const registration of REGISTRATIONS) {
        const base = registration.execute;
        const write = /(write|drive)$/.test(registration.name);
        editor.add({
          ...registration,
          options: { namespace: NAMESPACE, codemode: true, ...registration.options },
          execute: async (input, context) => {
            // A mutating tool asserts an action under its own id, so project rules (and the generated
            // preset) can deny or ask for it by name; reads assert nothing (decision c). Only a host
            // that carries the documented permission domain gets the assert — otherwise plain.
            if (assertable && write) {
              await permission.assert({
                sessionID: context?.sessionID,
                source: context?.messageID
                  ? { type: "tool", messageID: context.messageID, id: context.id }
                  : undefined,
                action: registration.name,
                resources: ["*"],
              });
            }
            const withRoot = boundRoot && !input.root ? { ...input, root: boundRoot } : input;
            return base(withRoot, context);
          },
        });
      }
    });
  },
};

// The host's loader contract (measured live, service log): the default export carries the id and the
// setup function; this named export stays only for the tests that import it.
export default Plugin;
