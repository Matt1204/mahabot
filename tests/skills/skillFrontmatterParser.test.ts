import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { parseSkillFrontmatter } from "../../src/agent/skills/skillFrontmatterParser.ts";

describe("parseSkillFrontmatter", () => {
  test("parses name/description and extracts exact description raw slice", () => {
    const markdown = [
      "---",
      "name: code-review",
      'description: "Review pull requests with risk analysis. Use when user asks for review."',
      "---",
      "# body",
    ].join("\n");

    const result = parseSkillFrontmatter(markdown, "fallback-name", "/tmp/skill/SKILL.md");
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }

    assert.equal(result.name, "code-review");
    assert.equal(
      result.description.value,
      "Review pull requests with risk analysis. Use when user asks for review."
    );
    assert.equal(
      result.description.rawSlice,
      '"Review pull requests with risk analysis. Use when user asks for review."'
    );
    assert.deepEqual(result.warnings, []);
  });

  test("falls back to directory name when name is missing", () => {
    const markdown = ["---", "description: Handles docs. Use when user asks for docs.", "---"].join("\n");
    const result = parseSkillFrontmatter(markdown, "docs-skill", "/tmp/docs-skill/SKILL.md");

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.name, "docs-skill");
    assert.equal(result.description.value, "Handles docs. Use when user asks for docs.");
  });

  test("falls back description to name when description is missing", () => {
    const markdown = ["---", "name: audit-skill", "---"].join("\n");
    const result = parseSkillFrontmatter(markdown, "audit-skill", "/tmp/audit/SKILL.md");

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.description.value, "audit-skill");
    assert.equal(result.warnings.length, 1);
    assert.equal(result.warnings[0]?.code, "description_fallback");
  });

  test("returns parse_failed when frontmatter is missing", () => {
    const markdown = "# no frontmatter";
    const result = parseSkillFrontmatter(markdown, "no-frontmatter", "/tmp/no-frontmatter/SKILL.md");

    assert.equal(result.ok, false);
    assert.equal(result.warnings.length, 1);
    assert.equal(result.warnings[0]?.code, "parse_failed");
  });

  test("keeps best-effort description but warns for guide violations", () => {
    const markdown = [
      "---",
      "name: risky-skill",
      "description: Uses <xml> brackets. Use when user asks for risky mode.",
      "---",
    ].join("\n");
    const result = parseSkillFrontmatter(markdown, "risky-skill", "/tmp/risky/SKILL.md");

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.description.value, "Uses <xml> brackets. Use when user asks for risky mode.");
    assert.ok(result.warnings.some((warning) => warning.code === "description_guide_violation"));
  });
});

