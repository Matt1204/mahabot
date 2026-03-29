import { Type } from "@mariozechner/pi-ai";

import type { DescribedAgentTool } from "./registry/types.js";
import { textResult } from "./showcase/shared.js";

const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS_LIMIT = 10;
const DOMAIN_LIST_LIMIT = 20;
const TAVILY_API_URL = "https://api.tavily.com/search";
const LINKUP_API_URL = "https://api.linkup.so/v1/search";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

type WebSearchProvider = "tavily" | "linkup";

interface CreateWebSearchToolInput {
  tavilyApiKeyEnvVar?: string;
  linkupApiKeyEnvVar?: string;
  fetchImpl?: FetchLike;
}

type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  }
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

interface UnifiedSearchResult {
  url: string;
  description: string;
  title?: string;
  provider: WebSearchProvider;
  score?: number;
  published_date?: string;
}

interface WebSearchDetails {
  tool: "web_search";
  ok: boolean;
  providerTried: WebSearchProvider[];
  providerUsed?: WebSearchProvider;
  fallbackReason?: "tavily_insufficient_credits";
  query: string;
  resultCount?: number;
  errorCode?:
    | "invalid_input"
    | "tavily_failed_non_credit"
    | "tavily_insufficient_credits"
    | "linkup_insufficient_credits"
    | "linkup_failed_after_fallback"
    | "all_providers_insufficient_credits"
    | "network_error"
    | "unexpected_provider_payload";
  message?: string;
}

interface NormalizedInput {
  query: string;
  maxResults: number;
  startDate?: string;
  endDate?: string;
  includeDomains: string[];
  excludeDomains: string[];
}

interface ProviderSuccess<TData> {
  ok: true;
  data: TData;
}

interface ProviderFailure {
  ok: false;
  status: number | null;
  message: string;
  isNetworkError: boolean;
}

type ProviderResult<TData> = ProviderSuccess<TData> | ProviderFailure;

interface TavilyResultRow {
  url?: unknown;
  content?: unknown;
  title?: unknown;
  score?: unknown;
  published_date?: unknown;
}

interface TavilySearchResponse {
  results?: unknown;
}

interface LinkupResultRow {
  url?: unknown;
  content?: unknown;
  name?: unknown;
}

interface LinkupSearchResponse {
  results?: unknown;
}

const DEFAULT_GET_ENV = (name: string): string | undefined => process.env[name];

export function createWebSearchTool(input: CreateWebSearchToolInput = {}): DescribedAgentTool {
  const schema = Type.Object({
    query: Type.String({
      minLength: 1,
      description: "Search query. Keep it focused and concise.",
    }),
    max_results: Type.Optional(
      Type.Number({
        minimum: 1,
        maximum: MAX_RESULTS_LIMIT,
        description: "Maximum number of results to return.",
      })
    ),
    start_date: Type.Optional(
      Type.String({
        description: "Start date filter in YYYY-MM-DD.",
      })
    ),
    end_date: Type.Optional(
      Type.String({
        description: "End date filter in YYYY-MM-DD.",
      })
    ),
    include_domains: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), {
        description: "Only search within these domains.",
      })
    ),
    exclude_domains: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), {
        description: "Exclude these domains from search.",
      })
    ),
  });

  const fetchImpl = input.fetchImpl ?? defaultFetch;
  const tavilyApiKeyEnvVar = input.tavilyApiKeyEnvVar ?? "TAVILY_API_KEY";
  const linkupApiKeyEnvVar = input.linkupApiKeyEnvVar ?? "LINKUP_API_KEY";
  const getEnv = DEFAULT_GET_ENV;

  const tool: DescribedAgentTool = {
    name: "web_search",
    label: "Web Search",
    description:
      "Broad web discovery tool (Google-like): returns URL + description candidates. Use focused queries, split complex goals into multiple calls, and add date/domain filters when needed.",
    parameters: schema,
    async execute(_toolCallId, rawParams, signal) {
      const normalized = normalizeInput(rawParams);
      if (!normalized.ok) {
        return fail(normalized.queryForDetails, "invalid_input", normalized.message, []);
      }

      const inputParams = normalized.value;
      const providerTried: WebSearchProvider[] = ["tavily"];
      const tavilyApiKey = getEnv(tavilyApiKeyEnvVar)?.trim();
      if (!tavilyApiKey) {
        return fail(
          inputParams.query,
          "tavily_failed_non_credit",
          `Missing Tavily API key. Set environment variable '${tavilyApiKeyEnvVar}'.`,
          providerTried
        );
      }

      const tavilyResult = await searchWithTavily(fetchImpl, tavilyApiKey, inputParams, signal);
      if (tavilyResult.ok) {
        return success(inputParams.query, "tavily", providerTried, normalizeTavilyResults(tavilyResult.data, inputParams.maxResults));
      }

      if (tavilyResult.isNetworkError) {
        return fail(inputParams.query, "network_error", `Tavily request failed: ${tavilyResult.message}`, providerTried);
      }

      if (!isTavilyInsufficientCredits(tavilyResult.status, tavilyResult.message)) {
        return fail(
          inputParams.query,
          "tavily_failed_non_credit",
          `Tavily search failed (status ${tavilyResult.status ?? "unknown"}): ${tavilyResult.message}`,
          providerTried
        );
      }

      providerTried.push("linkup");
      const linkupApiKey = getEnv(linkupApiKeyEnvVar)?.trim();
      if (!linkupApiKey) {
        return fail(
          inputParams.query,
          "linkup_failed_after_fallback",
          `Missing Linkup API key. Set environment variable '${linkupApiKeyEnvVar}'.`,
          providerTried,
          "tavily_insufficient_credits"
        );
      }

      const linkupResult = await searchWithLinkup(fetchImpl, linkupApiKey, inputParams, signal);
      if (linkupResult.ok) {
        return success(
          inputParams.query,
          "linkup",
          providerTried,
          normalizeLinkupResults(linkupResult.data, inputParams.maxResults),
          "tavily_insufficient_credits"
        );
      }

      if (linkupResult.isNetworkError) {
        return fail(
          inputParams.query,
          "network_error",
          `Linkup request failed after Tavily fallback: ${linkupResult.message}`,
          providerTried,
          "tavily_insufficient_credits"
        );
      }

      if (isLinkupInsufficientCredits(linkupResult.status, linkupResult.message)) {
        return fail(
          inputParams.query,
          "all_providers_insufficient_credits",
          "Both Tavily and Linkup are unavailable due to credits or limits.",
          providerTried,
          "tavily_insufficient_credits"
        );
      }

      return fail(
        inputParams.query,
        "linkup_failed_after_fallback",
        `Linkup search failed (status ${linkupResult.status ?? "unknown"}): ${linkupResult.message}`,
        providerTried,
        "tavily_insufficient_credits"
      );
    },
  };

  return tool;
}

async function searchWithTavily(
  fetchImpl: FetchLike,
  apiKey: string,
  params: NormalizedInput,
  signal?: AbortSignal
): Promise<ProviderResult<TavilySearchResponse>> {
  const body: Record<string, unknown> = {
    query: params.query,
    max_results: params.maxResults,
    search_depth: "basic",
    include_answer: false,
    include_raw_content: false,
    include_images: false,
    include_image_descriptions: false,
    include_favicon: false,
    auto_parameters: false,
  };
  if (params.startDate) {
    body.start_date = params.startDate;
  }
  if (params.endDate) {
    body.end_date = params.endDate;
  }
  if (params.includeDomains.length > 0) {
    body.include_domains = params.includeDomains;
  }
  if (params.excludeDomains.length > 0) {
    body.exclude_domains = params.excludeDomains;
  }

  return postJson<TavilySearchResponse>(fetchImpl, TAVILY_API_URL, {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  }, body, signal);
}

async function searchWithLinkup(
  fetchImpl: FetchLike,
  apiKey: string,
  params: NormalizedInput,
  signal?: AbortSignal
): Promise<ProviderResult<LinkupSearchResponse>> {
  const body: Record<string, unknown> = {
    q: params.query,
    maxResults: params.maxResults,
    depth: "standard",
    outputType: "searchResults",
    includeImages: false,
  };
  if (params.startDate) {
    body.fromDate = params.startDate;
  }
  if (params.endDate) {
    body.toDate = params.endDate;
  }
  if (params.includeDomains.length > 0) {
    body.includeDomains = params.includeDomains;
  }
  if (params.excludeDomains.length > 0) {
    body.excludeDomains = params.excludeDomains;
  }

  return postJson<LinkupSearchResponse>(fetchImpl, LINKUP_API_URL, {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  }, body, signal);
}

async function postJson<TResponse>(
  fetchImpl: FetchLike,
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  signal?: AbortSignal
): Promise<ProviderResult<TResponse>> {
  let responseText = "";
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
    responseText = await response.text();

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        message: extractErrorMessage(responseText),
        isNetworkError: false,
      };
    }

    const parsed = safeParseJson(responseText);
    if (!parsed) {
      return {
        ok: false,
        status: response.status,
        message: "Provider returned non-JSON response.",
        isNetworkError: false,
      };
    }

    return { ok: true, data: parsed as TResponse };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      status: null,
      message,
      isNetworkError: true,
    };
  }
}

function normalizeTavilyResults(
  payload: TavilySearchResponse,
  maxResults: number
): UnifiedSearchResult[] {
  if (!Array.isArray(payload.results)) {
    return [];
  }

  const rows: UnifiedSearchResult[] = [];
  for (const rawRow of payload.results as TavilyResultRow[]) {
    const url = normalizeString(rawRow.url);
    if (!url) {
      continue;
    }

    const title = normalizeString(rawRow.title);
    const content = normalizeString(rawRow.content);
    const description = content || title || "No description available.";
    const score = toFiniteNumber(rawRow.score);
    const publishedDate = normalizeString(rawRow.published_date);

    rows.push({
      url,
      description,
      title: title || undefined,
      provider: "tavily",
      score: score ?? undefined,
      published_date: publishedDate || undefined,
    });
  }

  return dedupeByUrl(rows).slice(0, maxResults);
}

function normalizeLinkupResults(
  payload: LinkupSearchResponse,
  maxResults: number
): UnifiedSearchResult[] {
  if (!Array.isArray(payload.results)) {
    return [];
  }

  const rows: UnifiedSearchResult[] = [];
  for (const rawRow of payload.results as LinkupResultRow[]) {
    const url = normalizeString(rawRow.url);
    if (!url) {
      continue;
    }

    const title = normalizeString(rawRow.name);
    const content = normalizeString(rawRow.content);
    const description = content || title || "No description available.";

    rows.push({
      url,
      description,
      title: title || undefined,
      provider: "linkup",
    });
  }

  return dedupeByUrl(rows).slice(0, maxResults);
}

function dedupeByUrl(rows: UnifiedSearchResult[]): UnifiedSearchResult[] {
  const seen = new Set<string>();
  const unique: UnifiedSearchResult[] = [];
  for (const row of rows) {
    const key = canonicalizeUrlForDedup(row.url);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(row);
  }
  return unique;
}

function canonicalizeUrlForDedup(url: string): string {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.endsWith("/") && parsed.pathname !== "/"
      ? parsed.pathname.slice(0, -1)
      : parsed.pathname;
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return url.trim();
  }
}

function extractErrorMessage(responseText: string): string {
  const parsed = safeParseJson(responseText);
  if (parsed && typeof parsed === "object") {
    const record = parsed as Record<string, unknown>;
    const detail = record.detail;
    if (detail && typeof detail === "object") {
      const error = (detail as Record<string, unknown>).error;
      if (typeof error === "string" && error.trim().length > 0) {
        return error.trim();
      }
    }

    const message = record.message;
    if (typeof message === "string" && message.trim().length > 0) {
      return message.trim();
    }
  }

  const trimmed = responseText.trim();
  if (!trimmed) {
    return "Unknown provider error.";
  }
  return trimmed.length > 400 ? `${trimmed.slice(0, 400)}...` : trimmed;
}

function safeParseJson(text: string): unknown | null {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function isTavilyInsufficientCredits(status: number | null, message: string): boolean {
  if (status === 432 || status === 433) {
    return true;
  }

  const lower = message.toLowerCase();
  return (
    lower.includes("usage limit") ||
    lower.includes("pay-as-you-go limit") ||
    lower.includes("exceeds your plan") ||
    lower.includes("insufficient credits") ||
    lower.includes("credit balance")
  );
}

function isLinkupInsufficientCredits(status: number | null, message: string): boolean {
  const lower = message.toLowerCase();
  if (status === 429 && lower.includes("insufficient")) {
    return true;
  }
  return lower.includes("insufficient credits") || lower.includes("credit");
}

function success(
  query: string,
  providerUsed: WebSearchProvider,
  providerTried: WebSearchProvider[],
  results: UnifiedSearchResult[],
  fallbackReason?: "tavily_insufficient_credits"
) {
  return textResult(formatSuccessText(providerUsed, results), {
    tool: "web_search",
    ok: true,
    query,
    providerUsed,
    providerTried,
    fallbackReason,
    resultCount: results.length,
    results,
  } satisfies WebSearchDetails & { results: UnifiedSearchResult[] });
}

function fail(
  query: string,
  errorCode: NonNullable<WebSearchDetails["errorCode"]>,
  message: string,
  providerTried: WebSearchProvider[],
  fallbackReason?: "tavily_insufficient_credits"
) {
  return textResult(`Web search failed: ${message}`, {
    tool: "web_search",
    ok: false,
    query,
    providerTried,
    fallbackReason,
    errorCode,
    message,
  } satisfies WebSearchDetails);
}

function formatSuccessText(provider: WebSearchProvider, results: UnifiedSearchResult[]): string {
  if (results.length === 0) {
    return `Web search (${provider}) returned no results.`;
  }

  const lines = [`Web search provider: ${provider}`, `Results: ${results.length}`];
  for (let i = 0; i < results.length; i += 1) {
    const item = results[i];
    lines.push(`${i + 1}. ${truncate(item.description, 240)}`);
    lines.push(`   url: ${item.url}`);
  }
  return lines.join("\n");
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars - 3)}...`;
}

function normalizeInput(raw: Record<string, unknown>):
  | { ok: true; value: NormalizedInput }
  | { ok: false; queryForDetails: string; message: string } {
  const query = normalizeString(raw.query);
  if (!query) {
    return { ok: false, queryForDetails: "", message: "Invalid `query`: expected a non-empty string." };
  }

  const maxResults = normalizeMaxResults(raw.max_results);
  if (maxResults === null) {
    return { ok: false, queryForDetails: query, message: "Invalid `max_results`: expected an integer in [1, 10]." };
  }

  const startDate = normalizeOptionalDate(raw.start_date, "start_date");
  if (!startDate.ok) {
    return { ok: false, queryForDetails: query, message: startDate.message };
  }
  const endDate = normalizeOptionalDate(raw.end_date, "end_date");
  if (!endDate.ok) {
    return { ok: false, queryForDetails: query, message: endDate.message };
  }
  if (startDate.value && endDate.value && startDate.value > endDate.value) {
    return {
      ok: false,
      queryForDetails: query,
      message: "Invalid date range: `start_date` must be earlier than or equal to `end_date`.",
    };
  }

  const includeDomains = normalizeDomainList(raw.include_domains, "include_domains");
  if (!includeDomains.ok) {
    return { ok: false, queryForDetails: query, message: includeDomains.message };
  }
  const excludeDomains = normalizeDomainList(raw.exclude_domains, "exclude_domains");
  if (!excludeDomains.ok) {
    return { ok: false, queryForDetails: query, message: excludeDomains.message };
  }

  return {
    ok: true,
    value: {
      query,
      maxResults,
      startDate: startDate.value,
      endDate: endDate.value,
      includeDomains: includeDomains.value,
      excludeDomains: excludeDomains.value,
    },
  };
}

function normalizeMaxResults(value: unknown): number | null {
  if (value === undefined) {
    return DEFAULT_MAX_RESULTS;
  }
  if (!Number.isInteger(value)) {
    return null;
  }
  const asNumber = value as number;
  if (asNumber < 1 || asNumber > MAX_RESULTS_LIMIT) {
    return null;
  }
  return asNumber;
}

function normalizeOptionalDate(
  value: unknown,
  fieldName: "start_date" | "end_date"
): { ok: true; value?: string } | { ok: false; message: string } {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (typeof value !== "string") {
    return { ok: false, message: `Invalid \`${fieldName}\`: expected YYYY-MM-DD string.` };
  }
  const trimmed = value.trim();
  if (!DATE_PATTERN.test(trimmed)) {
    return { ok: false, message: `Invalid \`${fieldName}\`: expected YYYY-MM-DD.` };
  }
  const parsed = new Date(`${trimmed}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== trimmed) {
    return { ok: false, message: `Invalid \`${fieldName}\`: expected valid calendar date.` };
  }
  return { ok: true, value: trimmed };
}

function normalizeDomainList(
  value: unknown,
  fieldName: "include_domains" | "exclude_domains"
): { ok: true; value: string[] } | { ok: false; message: string } {
  if (value === undefined) {
    return { ok: true, value: [] };
  }
  if (!Array.isArray(value)) {
    return { ok: false, message: `Invalid \`${fieldName}\`: expected a string array.` };
  }
  if (value.length > DOMAIN_LIST_LIMIT) {
    return {
      ok: false,
      message: `Invalid \`${fieldName}\`: maximum ${DOMAIN_LIST_LIMIT} domains allowed.`,
    };
  }

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") {
      return { ok: false, message: `Invalid \`${fieldName}\`: domain entries must be strings.` };
    }
    const domain = item.trim();
    if (!domain) {
      return { ok: false, message: `Invalid \`${fieldName}\`: domain entries must be non-empty.` };
    }
    if (seen.has(domain)) {
      continue;
    }
    seen.add(domain);
    normalized.push(domain);
  }
  return { ok: true, value: normalized };
}

function normalizeString(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return value;
}

const defaultFetch: FetchLike = async (url, init) => {
  const response = await fetch(url, init as RequestInit);
  return response;
};

