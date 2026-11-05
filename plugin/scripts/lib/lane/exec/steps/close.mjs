// exec/steps/close — `lane exec close <id>`: the episode payload printed, and later the id
// episode_write gave stamped.
import { episodeStored } from "../../../memory/episodes.mjs";
import * as ledgers from "../../../process/ledger.mjs";
import { episodeOf } from "../episode.mjs";
import { laneLine, mustLedger, refuse } from "../lane.mjs";
import { view } from "../view.mjs";

export function run(ctx, id) {
  const { root, value: episodeId } = ctx;
  let ledger = mustLedger(root, id);
  if (episodeId !== null) {
    if (!ledger.episode?.payload) refuse(`no episode to stamp: run ${laneLine(root, "close", id)}`);
    const existing = ledger.episode.writtenId;
    if (existing && existing !== episodeId)
      refuse(`the episode is already stamped as ${existing}; not replacing it with ${episodeId}`);
    ledger = { ...ledger, episode: { ...ledger.episode, writtenId: episodeId } };
    ledgers.write(root, ledger);
    // The id is stamped as given; whether the memory store holds it is said, so a typo shows.
    const stored = episodeStored(root, episodeId);
    const warning = `no episode ${episodeId} in the memory store: check the id episode_write returned`;
    const shown = { id, step: "close", episode: ledger.episode, stored };
    return {
      exit: 0,
      out: JSON.stringify(stored ? shown : { ...shown, warning }, null, 2),
    };
  }
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
  ledger = {
    ...ledger,
    episode: { ...ledger.episode, payload },
    ...(ledger.state === "verified" && { next: "merge" }),
  };
  ledgers.write(root, ledger);
  const shown = view(ctx, ledger, {
    step: "close",
    extra: {
      episode: payload,
      afterwards: `episode_write with this payload, then ${laneLine(root, "close", id, " --episode <its id>")}`,
    },
  });
  return { ...shown, exit: 0 };
}
