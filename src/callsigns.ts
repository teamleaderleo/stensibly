import {
  baseCallsignCategories,
  suggestCallsigns,
  type BaseCallsignCategory,
  type CallsignSuggestionOptions,
  type CallsignSuggestionResult,
} from "./callsign-suggestions.js";

export interface ParsedCallsignCliArgs {
  help: boolean;
  json: boolean;
  options: CallsignSuggestionOptions;
}

export function parseCallsignCliArgs(
  rawArgs: string[],
  env: Record<string, string | undefined> = process.env,
): ParsedCallsignCliArgs {
  const args = rawArgs[0] === "--" ? rawArgs.slice(1) : [...rawArgs];
  let count = 5;
  let seed: string | undefined;
  let json = false;
  let help = false;
  const avoid = splitList(env.STENSIBLY_CALLSIGN_AVOID);
  const categories = splitList(env.STENSIBLY_CALLSIGN_CATEGORIES)
    .map(parseCategory);

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--count") {
      count = Number(requireValue(args, ++index, "--count"));
      continue;
    }
    if (argument === "--seed") {
      seed = requireValue(args, ++index, "--seed");
      continue;
    }
    if (argument === "--avoid") {
      avoid.push(...splitList(requireValue(args, ++index, "--avoid")));
      continue;
    }
    if (argument === "--category") {
      categories.push(...splitList(requireValue(args, ++index, "--category")).map(parseCategory));
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  return {
    help,
    json,
    options: {
      count,
      ...(seed === undefined ? {} : { seed }),
      ...(avoid.length === 0 ? {} : { avoid }),
      ...(categories.length === 0 ? {} : { categories }),
    },
  };
}

export function formatCallsignSuggestions(
  result: CallsignSuggestionResult,
  json: boolean,
): string {
  if (json) return JSON.stringify(result, null, 2);
  return result.suggestions
    .map((suggestion) => `${suggestion.callsign}\t${suggestion.category}\t${suggestion.source}`)
    .join("\n");
}

export function callsignUsage(): string {
  return `Usage: bun run callsigns -- [options]

Suggest short callsigns without reserving identity or granting authority.

Options:
  --count <1-20>       Number of suggestions (default: 5)
  --seed <text>        Deterministic seed for replay
  --avoid <names>      Comma-separated callsigns to avoid; repeatable
  --category <names>   Preferred categories; repeatable
  --json               Emit the complete typed result as JSON
  --help, -h           Show this help

Categories: ${baseCallsignCategories.join(", ")}

Environment:
  STENSIBLY_CALLSIGN_AVOID        Comma-separated avoid list
  STENSIBLY_CALLSIGN_CATEGORIES   Comma-separated category preferences`;
}

function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseCategory(value: string): BaseCallsignCategory {
  const normalized = value.trim().toLowerCase();
  if (baseCallsignCategories.includes(normalized as BaseCallsignCategory)) {
    return normalized as BaseCallsignCategory;
  }
  throw new Error(`Unknown callsign category: ${value}`);
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

if (import.meta.main) {
  try {
    const parsed = parseCallsignCliArgs(Bun.argv.slice(2));
    if (parsed.help) {
      console.log(callsignUsage());
    } else {
      console.log(formatCallsignSuggestions(suggestCallsigns(parsed.options), parsed.json));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
