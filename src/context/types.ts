export type PromptSectionId = "agents" | "runtime" | "tools" | "soul" | "user" | "memory" | "skills";

export interface PromptSection {
  id: PromptSectionId;
  required: boolean;
  content: string;
}

export interface ContextAssemblyResult {
  systemPrompt: string;
  sections: PromptSection[];
  diagnostics: {
    promptCharCount: number;
    usedTemplateFallback: Array<"SOUL.md" | "USER.md">;
  };
}
