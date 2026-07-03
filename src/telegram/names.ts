// Random three-word topic names (e.g. `amber-falcon-tide`).
//
// `/new` topics are titled with a random, memorable, kid-safe name rather than
// a running counter — this sidesteps title collisions and makes topics easy to
// tell apart at a glance. The word list is embedded (no I/O) and every entry is
// lowercase a-z, 3–8 chars, so any join of three matches
// `^[a-z]{3,8}-[a-z]{3,8}-[a-z]{3,8}$`.

const WORDS: readonly string[] = [
  // adjectives
  "amber", "azure", "brave", "bright", "calm", "cheery", "clever", "cozy",
  "crisp", "dandy", "eager", "early", "fancy", "fluffy", "fresh", "funny",
  "gentle", "giant", "glad", "golden", "grand", "happy", "jolly", "kind",
  "lively", "lucky", "merry", "mighty", "misty", "neat", "noble", "plucky",
  "proud", "quick", "quiet", "rapid", "rosy", "royal", "shiny", "silly",
  "silver", "sleepy", "smooth", "snappy", "snowy", "soft", "sunny", "sweet",
  "swift", "tidy", "tiny", "warm", "wavy", "wise", "witty", "zesty",
  "breezy", "sandy", "frosty", "dusty", "leafy", "mellow", "nifty", "perky",
  "spry", "sturdy",
  // nouns
  "falcon", "tide", "meadow", "river", "maple", "otter", "pebble", "willow",
  "cedar", "comet", "ember", "forest", "harbor", "island", "jungle", "lagoon",
  "lantern", "marble", "orchard", "panda", "pigeon", "rabbit", "salmon",
  "sparrow", "sunset", "thistle", "tulip", "walnut", "badger", "beaver",
  "bison", "cactus", "canyon", "cavern", "cherry", "cloud", "cricket", "daisy",
  "dolphin", "feather", "ferret", "garden", "hazel", "heron", "hollow", "ivy",
  "kitten", "ladder", "lemon", "lizard", "lotus", "maize", "mango", "marsh",
  "nectar", "ocean", "olive", "pepper", "pony", "poppy", "puffin", "quail",
  "robin", "sierra", "spruce", "summit", "tiger", "timber", "valley", "walrus",
  "wombat", "yarrow", "zephyr", "acorn", "anchor", "arrow", "basket", "bramble",
  "brook", "bubble", "button", "candle", "carrot", "castle", "clover", "cobble",
  "cocoa", "cotton", "cradle", "crayon", "dapple", "dimple", "doodle", "fiddle",
  "gadget", "giggle", "honey", "jigsaw", "kettle", "muffin", "noodle", "nugget",
  "nutmeg", "paddle", "pickle", "pillow", "pocket", "puzzle", "ribbon", "saddle",
  "sailor", "sundae", "tinsel", "turnip", "velvet", "waffle", "wagon", "whisk",
  "yonder",
];

/**
 * A random `{word}-{word}-{word}` name with three DISTINCT words drawn from the
 * embedded list. Suitable as a forum-topic title.
 */
export function randomName(): string {
  const pool = [...WORDS];
  const picked: string[] = [];
  for (let i = 0; i < 3; i++) {
    const idx = Math.floor(Math.random() * pool.length);
    picked.push(pool.splice(idx, 1)[0]!);
  }
  return picked.join("-");
}
