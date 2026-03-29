import { readdir, readFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { resolve } from "node:path";

import { parseSkillFrontmatter } from "./skillFrontmatterParser.js";
import { renderSkillsXmlSummary } from "./skillsPromptRenderer.js";
import type { SkillMetadata, SkillParseWarning, SkillsSummaryBuildResult } from "./types.js";

export interface BuildSkillsSummaryInput {
  workspaceSkillsRoot: string;
  builtinSkillsRoot: string;
}

interface ScanRootResult {
  skills: SkillMetadata[];
  warnings: SkillParseWarning[];
  scanned: number;
  skipped: number;
}

export class SkillsCatalogService {
  async buildSkillsSummary(input: BuildSkillsSummaryInput): Promise<SkillsSummaryBuildResult> {
    const builtin = await this.scanSkillRoot(input.builtinSkillsRoot);
    const workspace = await this.scanSkillRoot(input.workspaceSkillsRoot);

    const mergedByName = new Map<string, SkillMetadata>();
    for (const skill of builtin.skills) {
      mergedByName.set(skill.name, skill);
    }
    for (const skill of workspace.skills) {
      mergedByName.set(skill.name, skill);
    }

    const skills = [...mergedByName.values()].sort((left, right) => left.name.localeCompare(right.name));
    const warnings = [...builtin.warnings, ...workspace.warnings];
    const scanned = builtin.scanned + workspace.scanned;
    const skipped = builtin.skipped + workspace.skipped;

    return {
      skills,
      xmlSummary: renderSkillsXmlSummary(skills),
      warnings,
      stats: {
        scanned,
        loaded: skills.length,
        skipped,
      },
    };
  }

  private async scanSkillRoot(root: string): Promise<ScanRootResult> {
    let entries: Dirent<string>[];
    try {
      entries = await readdir(root, { withFileTypes: true, encoding: "utf-8" });
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return { skills: [], warnings: [], scanned: 0, skipped: 0 };
      }

      return {
        skills: [],
        warnings: [
          {
            code: "parse_failed",
            message: `Failed to scan skills root: ${formatError(error)}`,
            location: root,
          },
        ],
        scanned: 0,
        skipped: 0,
      };
    }

    const sortedDirectories = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));

    const skills: SkillMetadata[] = [];
    const warnings: SkillParseWarning[] = [];
    let scanned = 0;
    let skipped = 0;

    for (const directoryName of sortedDirectories) {
      const location = resolve(root, directoryName, "SKILL.md");
      let markdown: string;

      try {
        markdown = await readFile(location, "utf-8");
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
          continue;
        }

        scanned += 1;
        skipped += 1;
        warnings.push({
          code: "parse_failed",
          message: `Failed to read SKILL.md: ${formatError(error)}`,
          location,
        });
        continue;
      }

      scanned += 1;

      const parsed = parseSkillFrontmatter(markdown, directoryName, location);
      warnings.push(...parsed.warnings);
      if (!parsed.ok) {
        skipped += 1;
        continue;
      }

      skills.push({
        name: parsed.name,
        description: parsed.description.value,
        location,
      });
    }

    return {
      skills,
      warnings,
      scanned,
      skipped,
    };
  }
}

export function resolveBuiltinSkillsRoot(cwd = process.cwd()): string {
  return resolve(cwd, "src", "agent", "skills");
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}
