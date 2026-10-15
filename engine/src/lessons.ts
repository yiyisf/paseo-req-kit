// Recurring review findings: the report step writes lessons.tsv (problems a project-level
// rule would prevent); the overview and /req-retro look for a category that keeps coming
// back across requirements, the cue to turn it into a lint rule, a type, a test or a note.

import fs from "node:fs";
import path from "node:path";
import type { FeatureSummary } from "./features.js";
import { PROJECT_DIR } from "./prompts.js";

export interface Lesson {
  category: string;
  finding: string;
  source: string;
  rule: string;
  layer: string;
}

export interface RecurringLesson {
  category: string;
  /** Requirements (directory names) the category appeared in. */
  features: string[];
  /** Suggested rules, as written, without repeats. */
  rules: string[];
}

/** Rows of a lessons.tsv; an unreadable or missing file gives none. */
export function readLessons(file: string): Lesson[] {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8").replace(/^﻿/, "");
  } catch {
    return [];
  }
  const [header, ...rows] = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (!header) return [];
  const columns = header.split("\t").map((c) => c.trim());
  const at = (name: string) => columns.indexOf(name);
  return rows
    .map((row) => row.split("\t"))
    .map((cells) => {
      const get = (name: string) => (at(name) >= 0 ? (cells[at(name)] ?? "").trim() : "");
      return { category: get("category"), finding: get("finding"), source: get("source"), rule: get("rule"), layer: get("layer") };
    })
    .filter((l) => l.category !== "");
}

/** Categories already turned into rules (or set aside), one per line in .requirement-pipeline/lessons-handled.txt. */
export function handledCategories(repo: string): Set<string> {
  try {
    const text = fs.readFileSync(path.join(repo, PROJECT_DIR, "lessons-handled.txt"), "utf8");
    return new Set(text.split(/\r?\n/).map((l) => l.replace(/#.*/, "").trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}

/** Categories found in at least `min` requirements, most frequent first. */
export function recurringLessons(features: FeatureSummary[], handled: Set<string> = new Set(), min = 2): RecurringLesson[] {
  const byCategory = new Map<string, RecurringLesson>();
  for (const f of features) {
    for (const lesson of readLessons(path.join(f.worktree, f.featureDir, "lessons.tsv"))) {
      if (handled.has(lesson.category)) continue;
      const entry = byCategory.get(lesson.category) ?? { category: lesson.category, features: [], rules: [] };
      if (!entry.features.includes(f.name)) entry.features.push(f.name);
      if (lesson.rule && !entry.rules.includes(lesson.rule)) entry.rules.push(lesson.rule);
      byCategory.set(lesson.category, entry);
    }
  }
  return [...byCategory.values()]
    .filter((e) => e.features.length >= min)
    .sort((a, b) => b.features.length - a.features.length || a.category.localeCompare(b.category));
}
