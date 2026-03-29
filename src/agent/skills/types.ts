export interface SkillMetadata {
  name: string;
  description: string;
  location: string;
}

export type SkillParseWarningCode =
  | "parse_failed"
  | "description_fallback"
  | "description_guide_violation";

export interface SkillParseWarning {
  code: SkillParseWarningCode;
  message: string;
  location: string;
}

export interface SkillDescriptionExtraction {
  value: string;
  rawSlice?: string;
  range?: {
    start: number;
    end: number;
  };
}

export interface SkillsSummaryBuildResult {
  skills: SkillMetadata[];
  xmlSummary: string;
  warnings: SkillParseWarning[];
  stats: {
    scanned: number;
    loaded: number;
    skipped: number;
  };
}

