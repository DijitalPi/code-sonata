// node orchestra/check-data.mjs <folder>: whether the server would trust the ledgers in a folder (a backup about to be
// restored): orders.json with every order whole (orders.mjs `bookProblem`), auction.json if there with every bid whole
// (auction.mjs `auctionProblem`), and the two agreeing (`ledgersProblem`). Prints why not and exits 1.
// deploy/restore.sh runs it before anything changes.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { bookProblem } from "./orders.mjs";
import { auctionProblem, ledgersProblem } from "./auction.mjs";

const dir = process.argv[2];
const read = (name) => JSON.parse(readFileSync(join(dir, name), "utf8"));
const problem = (name, check) => {
  try { const why = check(read(name)); return why && `${name}: ${why}`; }
  catch (error) { return `${name}: ${error.message}`; }
};
const auction = existsSync(join(dir, "auction.json"));
const found = [problem("orders.json", bookProblem), auction && problem("auction.json", auctionProblem)].filter(Boolean);
const apart = !found.length && auction && problem("auction.json", (data) => ledgersProblem(data, read("orders.json")));
if (apart) found.push(apart);
for (const why of found) console.error(why);
process.exitCode = found.length ? 1 : 0;
