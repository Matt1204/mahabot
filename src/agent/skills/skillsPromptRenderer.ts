import type { SkillMetadata } from "./types.js";

export function renderSkillsPromptSection(skills: SkillMetadata[]): string {
  return [
    "## Skills",
    "Skills are reusable capability/knowledge/scripts folders. Each skill is discovered by its SKILL.md.",
    "This prompt includes skill metadata only. To use a skill, read its SKILL.md with read_file.",
    "",
    renderSkillsXmlSummary(skills),
  ].join("\n");
}

export function renderSkillsXmlSummary(skills: SkillMetadata[]): string {
  const lines: string[] = ["<skills>"];

  for (const skill of skills) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    lines.push(`    <location>${escapeXml(skill.location)}</location>`);
    lines.push("  </skill>");
  }

  lines.push("</skills>");
  return lines.join("\n");
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

