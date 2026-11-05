// exec/steps/close — `lane exec close <id>`: the lane's episode written to the repo's memory store
// (`<root>/.agentry/memory`) and its id stamped in the ledger, in one call. `--episode <id>` (stamp an id
// written elsewhere) is still taken for one version, with a deprecation line.
import { episodeStored, recordEpisode } from "../../../memory/episodes.mjs";
import * as ledgers from "../../../process/ledger.mjs";
import { episodeOf } from "../episode.mjs";
import { laneLine, mustLedger, refuse, stop } from "../lane.mjs";
import { view } from "../view.mjs";

const DEPRECATED =
  "--episode is deprecated and goes in the next version: exec close writes the episode itself";

// The old two-step close: stamp the id an episode write elsewhere returned.
function stamp(root, id, ledger, episodeId) {
  if (!ledger.episode?.payload) refuse(`no episode to stamp: run ${laneLine(root, "close", id)}`);
  const existing = ledger.episode.writtenId;
  if (existing && existing !== episodeId)
    refuse(`the episode is already stamped as ${existing}; not replacing it with ${episodeId}`);
  const stamped = { ...ledger, episode: { ...ledger.episode, writtenId: episodeId } };
  ledgers.write(root, stamped);
  // The id is stamped as given; whether the memory store holds it is said, so a typo shows.
  const stored = episodeStored(root, episodeId);
  const warning = `no episode ${episodeId} in the memory store: check the id the episode write returned`;
  const shown = { id, step: "close", episode: stamped.episode, stored, deprecated: DEPRECATED };
  return { exit: 0, out: JSON.stringify(stored ? shown : { ...shown, warning }, null, 2) };
}

export function run(ctx, id) {
  const { root, value: episodeId } = ctx;
  let ledger = mustLedger(root, id);
  if (episodeId !== null) return stamp(root, id, ledger, episodeId);
  if (ledger.episode?.writtenId) {
    // Closed again after a rebase or an owner's fix: the episode stands, and the land is next again.
    if (ledger.state === "verified" && ledger.next === "close") {
      ledger = { ...ledger, next: "merge" };
      ledgers.write(root, ledger);
    }
    return {
      exit: 0,
      out: JSON.stringify(
        {
          id,
          step: "close",
          next: ledger.next,
          episode: ledger.episode,
          already: `the episode is written (${ledger.episode.writtenId}): write nothing more`,
        },
        null,
        2,
      ),
    };
  }
  const closable =
    ledger.next === "close" ||
    ledger.state === "stopped" ||
    ledger.state === "merged" ||
    ledger.cut ||
    ledger.episode;
  if (!closable) refuse(`the lane is not done (state ${ledger.state}, next ${ledger.next})`);
  const payload = episodeOf(ledger);
  let written;
  try {
    written = recordEpisode(root, payload).id;
  } catch (e) {
    stop(
      `the episode was not written (${e.message}): nothing recorded → fix the memory store, then ${laneLine(root, "close", id)}`,
    );
  }
  ledger = {
    ...ledger,
    episode: { ...ledger.episode, payload, writtenId: written },
    ...(ledger.state === "verified" && { next: "merge" }),
  };
  ledgers.write(root, ledger);
  // The id is in the ledger (`exec show`); the output says only that it is stored, so it reads the same
  // on every run.
  const shown = view(ctx, ledger, { step: "close", extra: { episode: payload, stored: true } });
  return { ...shown, exit: 0 };
}
