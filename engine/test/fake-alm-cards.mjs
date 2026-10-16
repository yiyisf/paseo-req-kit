#!/usr/bin/env node
// Stands in for `shenbing alm-card` in the card tests (1.10): cards live in a JSON file
// (FAKE_ALM_CARDS, next to this script by default); every call is logged to <cards>.log.
//   alm-card view <id> --fields …          {"success":true,"data":{globalId,name,state,createdBy,subsysName,description}}
//   alm-card edit <id> -b <description>     replaces the description
//   alm-card edit <id> --state-detail <s>   changes the state
import fs from "node:fs";
import path from "node:path";

const file = process.env.FAKE_ALM_CARDS ?? path.join(path.dirname(new URL(import.meta.url).pathname), "cards.json");
const args = process.argv.slice(2);
fs.appendFileSync(`${file}.log`, `${JSON.stringify(args)}\n`);
const cards = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
const [, command, id] = args;
const card = cards[id];
if (command === "view") {
  if (!card) {
    console.log(JSON.stringify({ success: false, message: `卡片 ${id} 不存在` }));
    process.exit(1);
  }
  console.log("正在查询…");
  console.log(JSON.stringify({ success: true, data: { globalId: id, ...card } }, null, 2));
} else if (command === "edit") {
  if (!card) {
    console.error(`卡片 ${id} 不存在`);
    process.exit(1);
  }
  const b = args.indexOf("-b");
  if (b >= 0) card.description = args[b + 1];
  const s = args.indexOf("--state-detail");
  if (s >= 0) card.state = args[s + 1];
  fs.writeFileSync(file, JSON.stringify(cards, null, 2));
  console.log("修改成功");
} else {
  console.error(`不认识的命令 ${command}`);
  process.exit(2);
}
