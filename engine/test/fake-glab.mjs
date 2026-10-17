#!/usr/bin/env node
// Stands in for a GitLab command line in the merge request test (1.12): logs its arguments and
// working directory to FAKE_GLAB_LOG and prints a merge request address like `glab mr create` does.
import fs from "node:fs";

fs.appendFileSync(process.env.FAKE_GLAB_LOG ?? "/dev/null", `${JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) })}\n`);
if (process.env.FAKE_GLAB_FAIL) {
  console.error("error: not logged in to gitlab.example");
  process.exit(1);
}
console.log("Creating draft merge request for req/x into main in team/shop\n\nhttps://gitlab.example/team/shop/-/merge_requests/7");
